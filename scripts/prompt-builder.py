import ollama
import chromadb
import os
import json
import time
import argparse
from pathlib import Path
from pathspec import PathSpec
from pathspec.patterns import GitWildMatchPattern
from concurrent.futures import ProcessPoolExecutor, as_completed
# tqdm is great for interactive CLI, but for programmatic use,
# we'll rely on custom JSON progress messages.
# from tqdm import tqdm
from tree_sitter import Parser
from tree_sitter_languages import get_language as ts_get_language, get_parser as ts_get_parser

# --- Constants ---
# These remain, but PROJECT_DIRECTORIES and CHROMA_DB_PATH will be primarily driven by args
EXCLUDE_DIRS = [
    ".git", ".idea", "node_modules", "build", "dist", "out", "venv",
    "__pycache__", "target", "bin", "obj", "gradle", "pubspec.lock",
    "emulators", "Pods", ".cxx", "vector_stores" # Exclude our own DB store
]
TREE_SITTER_CONFIG = {
    # Add tree-sitter configurations here if you have specific languages
    # Example:
    # '.py': {
    #     "language": "python",
    #     "nodes_to_capture": ["function_definition", "class_definition"],
    #     "min_node_lines": 3
    # },
    # '.js': {
    #     "language": "javascript",
    #     "nodes_to_capture": ["function_declaration", "class_declaration", "method_definition"],
    #     "min_node_lines": 3
    # }
}
LINE_CHUNK_FALLBACK_EXTENSIONS = ['.dart', '.js', '.html', '.css', '.yaml', '.json', '.md', '.txt', '.py', '.java', '.ts', '.tsx', '.go', '.rb', '.php', '.c', '.cpp', '.h', '.cs', '.swift', '.kt', '.rs'] # Expanded list

OLLAMA_EMBEDDING_MODEL = 'nomic-embed-text'
# CHROMA_DB_PATH will be set dynamically based on script location and gemini-coder structure
# Default path relative to this script's parent directory (gemini-coder/)
DEFAULT_CHROMA_DB_PARENT_DIR = Path(__file__).resolve().parent.parent / "vector_stores"
DEFAULT_CHROMA_DB_NAME = "codedb_chroma_ts"
CHROMA_COLLECTION_NAME = "code_collection_ts"
# LAST_INDEX_TIMESTAMP_FILE will also be relative to the dynamic CHROMA_DB_PATH

TOP_K_FILES_TO_RETRIEVE = 10 # Reduced for conciseness in prompts, adjust as needed
MIN_CHUNK_SIZE_LINES_FALLBACK = 5
MAX_CHUNK_SIZE_LINES_FALLBACK = 30
OVERLAP_LINES_FALLBACK = 3

_parsers_cache = {}

# --- Helper Functions (largely unchanged, but with minor adjustments) ---

def get_parser_for_language(lang_name, parser_options=None):
    if lang_name not in _parsers_cache:
        try:
            language = ts_get_language(lang_name)
            if not language:
                # print_json_output("error", f"ts_get_language('{lang_name}') returned None.")
                return None
            parser = Parser()
            parser.set_language(language)
            _parsers_cache[lang_name] = parser
        except Exception as e:
            # import traceback
            # print_json_output("error", f"Could not load tree-sitter language or set up parser for '{lang_name}': {e}\n{traceback.format_exc()}")
            return None
    return _parsers_cache.get(lang_name)

def extract_nodes_recursive(node, target_node_types, min_lines):
    chunks = []
    if node.type in target_node_types:
        start_line = node.start_point[0]
        end_line = node.end_point[0]
        num_lines = end_line - start_line + 1
        if num_lines >= min_lines:
            chunks.append({
                "text": node.text.decode('utf-8', errors='ignore'),
                "type": node.type,
                "start_line": start_line,
                "end_line": end_line
            })
        return chunks # Return early if a target node is found and chunked
    
    for child in node.children:
        chunks.extend(extract_nodes_recursive(child, target_node_types, min_lines))
    return chunks

def chunk_with_tree_sitter(content, file_path_str, lang_config):
    parser = get_parser_for_language(lang_config["language"], lang_config.get("parser_options"))
    if not parser:
        return None
    tree = parser.parse(bytes(content, "utf8"))
    chunks_data = []
    if tree.root_node:
        extracted_nodes = extract_nodes_recursive(
            tree.root_node,
            lang_config["nodes_to_capture"],
            lang_config["min_node_lines"]
        )
        for node_info in extracted_nodes:
            chunks_data.append({
                "text": node_info["text"],
                "file_path": file_path_str,
                "type": f"ts_{node_info['type']}",
                "start_line": node_info['start_line'],
                "end_line": node_info['end_line']
            })
    return chunks_data

def chunk_code_by_lines(content, file_path_str, min_lines, max_lines, overlap_lines):
    chunks = []
    lines = content.splitlines()
    if not lines:
        return []

    current_chunk_start_line = 0
    i = 0
    while i < len(lines):
        chunk_lines = lines[i : i + max_lines]
        if len(chunk_lines) < min_lines and i + len(chunk_lines) < len(lines): # if too small and not end
             i += len(chunk_lines) # effectively discard and try next
             current_chunk_start_line += len(chunk_lines)
             continue

        chunk_text = "\n".join(chunk_lines).strip()
        if chunk_text:
            chunks.append({
                "text": chunk_text,
                "file_path": file_path_str,
                "type": "line_block",
                "start_line": current_chunk_start_line,
                "end_line": current_chunk_start_line + len(chunk_lines) -1
            })
        
        if i + len(chunk_lines) >= len(lines) : # end of file
            break
        
        # Move window forward, considering overlap
        advance_by = max(1, max_lines - overlap_lines)
        current_chunk_start_line += advance_by
        i += advance_by
        
    return chunks


def get_ollama_embedding(text_batch, model_name=OLLAMA_EMBEDDING_MODEL):
    embeddings = []
    for text in text_batch:
        try:
            response = ollama.embeddings(model=model_name, prompt=text)
            embeddings.append(response['embedding'])
        except Exception as e:
            # print_json_output("error", f"Error getting embedding for text: '{text[:50]}...': {e}")
            embeddings.append(None) # Keep list length consistent
    return embeddings

def load_gitignore(directory):
    gitignore_file = Path(directory) / ".gitignore"
    rules = []
    if gitignore_file.exists():
        with open(gitignore_file, "r", encoding='utf-8', errors='ignore') as f:
            rules = [line.strip() for line in f if line.strip() and not line.startswith("#")]
    # Always add default excludes like .git
    base_rules = [f"{excluded_dir}/" for excluded_dir in EXCLUDE_DIRS if not excluded_dir.startswith(".")]
    rules.extend(base_rules)
    return PathSpec.from_lines(GitWildMatchPattern, rules)


def is_ignored(file_path_obj, root_path_obj, gitignore_spec):
    # Check against EXCLUDE_DIRS first (simple string matching for performance)
    file_path_str_lower = str(file_path_obj).lower()
    for exclude_dir_pattern in EXCLUDE_DIRS:
        # Ensure it's a directory component
        if f"/{exclude_dir_pattern.lower()}/" in f"/{file_path_str_lower}/" or \
           file_path_str_lower.endswith(f"/{exclude_dir_pattern.lower()}"):
            return True

    if gitignore_spec:
        try:
            # For pathspec, path should be relative to the gitignore_spec's root (project_dir)
            # and use POSIX separators.
            relative_path_for_spec = file_path_obj.relative_to(root_path_obj).as_posix()
            if gitignore_spec.match_file(relative_path_for_spec):
                return True
            if file_path_obj.is_dir() and gitignore_spec.match_file(relative_path_for_spec + '/'): # Also check if dir itself is ignored
                return True
        except ValueError: # If file is not under root_path_obj (should not happen with rglob)
            pass
    return False

def process_file_for_chunks_and_embeddings(file_path_str, project_root_str):
    file_path = Path(file_path_str)
    ext = file_path.suffix.lower()
    results = []
    try:
        with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
        if not content.strip():
            return []

        chunk_data_list = []
        processed_by_ts = False
        if ext in TREE_SITTER_CONFIG:
            lang_config = TREE_SITTER_CONFIG[ext]
            # print_json_output("progress", f"Tree-sitter for {file_path_str} with {lang_config['language']}")
            chunk_data_list = chunk_with_tree_sitter(content, file_path_str, lang_config)
            if chunk_data_list:
                processed_by_ts = True
        
        if not chunk_data_list or (ext in LINE_CHUNK_FALLBACK_EXTENSIONS and not processed_by_ts):
            # print_json_output("progress", f"Line chunking for {file_path_str}")
            chunk_data_list = chunk_code_by_lines(
                content, file_path_str,
                MIN_CHUNK_SIZE_LINES_FALLBACK,
                MAX_CHUNK_SIZE_LINES_FALLBACK,
                OVERLAP_LINES_FALLBACK
            )

        if not chunk_data_list:
            return []

        texts_to_embed = [cd['text'] for cd in chunk_data_list]
        if not texts_to_embed:
            return []
        
        embeddings = get_ollama_embedding(texts_to_embed)
        
        for i, chunk_data in enumerate(chunk_data_list):
            if embeddings[i]: # Ensure embedding was successful
                metadata = {
                    "source_file": chunk_data["file_path"],
                    "chunk_type": chunk_data["type"],
                    "original_chunk_text_preview": chunk_data["text"][:200].replace('\n', ' ')
                }
                if "start_line" in chunk_data and "end_line" in chunk_data:
                     metadata["start_line"] = chunk_data["start_line"]
                     metadata["end_line"] = chunk_data["end_line"]
                results.append((embeddings[i], metadata))
        return results
    except Exception as e:
        # print_json_output("error", f"Error processing file {file_path_str}: {e}")
        return []

def get_last_index_meta_path(chroma_db_dir: Path) -> Path:
    return chroma_db_dir / "last_index_meta.json"

def load_last_index_meta(chroma_db_dir: Path):
    meta_file = get_last_index_meta_path(chroma_db_dir)
    if meta_file.exists():
        try:
            with open(meta_file, 'r') as f:
                return json.load(f)
        except json.JSONDecodeError:
            return {"timestamp": 0, "project_path": "unknown", "version": "unknown_json_error"}
    return {"timestamp": 0, "project_path": "unknown", "version": "initial"}

def save_last_index_meta(chroma_db_dir: Path, project_path_str: str, timestamp: float):
    meta_file = get_last_index_meta_path(chroma_db_dir)
    chroma_db_dir.mkdir(parents=True, exist_ok=True)
    with open(meta_file, 'w') as f:
        json.dump({"timestamp": timestamp, "project_path": project_path_str, "version": "1.1-ts-cli"}, f)

def print_json_output(type, message, **kwargs):
    """Prints structured JSON to stdout for parsing by Node.js."""
    payload = {"type": type, "message": message}
    payload.update(kwargs)
    print(json.dumps(payload))
    # Flush to ensure Node.js gets it immediately, especially for progress
    sys.stdout.flush()


def index_codebase(project_dir_str, chroma_db_dir_str, mode="update"):
    project_dir = Path(project_dir_str).resolve()
    chroma_db_path_obj = Path(chroma_db_dir_str).resolve()

    print_json_output("info", f"Starting codebase indexing for: {project_dir_str}")
    print_json_output("info", f"Database will be stored at: {chroma_db_path_obj}")
    print_json_output("info", f"Indexing mode: {mode}")

    client = chromadb.PersistentClient(path=str(chroma_db_path_obj))
    try:
        collection = client.get_or_create_collection(name=CHROMA_COLLECTION_NAME)
    except Exception as e:
        print_json_output("error", f"Fatal: Could not connect/create ChromaDB collection: {e}")
        return

    last_meta = load_last_index_meta(chroma_db_path_obj)
    last_index_timestamp = 0
    # If the DB was for a different project, or mode is full, treat as no valid prior timestamp
    if last_meta.get("project_path") == str(project_dir) and mode != "full":
        last_index_timestamp = last_meta.get("timestamp", 0)
    
    print_json_output("info", f"Last index for this project: {time.ctime(last_index_timestamp) if last_index_timestamp else 'Never or different project'}")

    files_to_process_map = {} # file_path_str -> project_root_str (which is just project_dir_str here)

    if mode == "full":
        print_json_output("info", f"Full re-index: Clearing collection '{collection.name}'...")
        # More robust collection clearing
        try:
            # client.delete_collection(name=CHROMA_COLLECTION_NAME) # Deletes and recreates
            # collection = client.get_or_create_collection(name=CHROMA_COLLECTION_NAME)
            # Simpler: just delete all items if collection exists
            count = collection.count()
            if count > 0:
                all_items = collection.get(limit=count, include=[]) # Get all IDs
                if all_items and all_items['ids']:
                    collection.delete(ids=all_items['ids'])
                    print_json_output("info", f"Deleted {len(all_items['ids'])} items from collection.")
            last_index_timestamp = 0 # Force re-index of all files
        except Exception as e:
            print_json_output("warning", f"Could not fully clear collection (or it was empty): {e}. Proceeding.")


    gitignore_spec = load_gitignore(project_dir)
    
    # Collect all candidate files
    candidate_files = []
    for file_path_obj in project_dir.rglob('*'):
        if file_path_obj.is_file() and \
           (file_path_obj.suffix.lower() in TREE_SITTER_CONFIG or \
            file_path_obj.suffix.lower() in LINE_CHUNK_FALLBACK_EXTENSIONS):
            if not is_ignored(file_path_obj, project_dir, gitignore_spec):
                candidate_files.append(file_path_obj)
    
    print_json_output("progress", f"Found {len(candidate_files)} candidate files.", percentage=5, total_files=len(candidate_files))

    modified_files_for_deletion_check = [] # For update mode

    for i, file_path_obj in enumerate(candidate_files):
        file_path_str = str(file_path_obj)
        if mode == "full":
            files_to_process_map[file_path_str] = str(project_dir)
        elif mode == "update":
            try:
                mtime = file_path_obj.stat().st_mtime
                if mtime > last_index_timestamp:
                    files_to_process_map[file_path_str] = str(project_dir)
                    modified_files_for_deletion_check.append(file_path_str)
            except FileNotFoundError:
                continue # File might have been deleted since rglob
        
        if (i + 1) % 50 == 0 or (i + 1) == len(candidate_files):
             print_json_output("progress", f"Scanned {i+1}/{len(candidate_files)} files for changes.", 
                               percentage=5 + int(25 * (i+1)/len(candidate_files)))


    if mode == "update" and modified_files_for_deletion_check:
        print_json_output("info", f"Found {len(modified_files_for_deletion_check)} modified/new files. Deleting their old entries if any...")
        # Batch deletion is complex with ChromaDB's current API for `where` filters if many files.
        # Deleting one by one here for simplicity, can be slow for many modified files.
        delete_progress_count = 0
        for f_path_str in modified_files_for_deletion_check: # No tqdm here, rely on JSON output
            try:
                # This deletes all chunks associated with the source_file
                collection.delete(where={"source_file": f_path_str})
            except Exception as e:
                print_json_output("warning", f"Could not delete old chunks for {f_path_str}: {e}")
            delete_progress_count += 1
            if delete_progress_count % 10 == 0 or delete_progress_count == len(modified_files_for_deletion_check):
                 print_json_output("progress", f"Deleting old chunks for modified files: {delete_progress_count}/{len(modified_files_for_deletion_check)}",
                                   percentage=30 + int(10 * delete_progress_count/len(modified_files_for_deletion_check)))


    if not files_to_process_map:
        print_json_output("info", "No files need processing (either up-to-date or no relevant files found).")
        if mode == "update": # If update mode and nothing to process, still save timestamp
            save_last_index_meta(chroma_db_path_obj, project_dir_str, time.time())
        return

    print_json_output("info", f"Processing {len(files_to_process_map)} files for embedding...")
    all_embeddings = []
    all_metadatas = []
    all_ids = []
    
    # Get current max doc_id, careful with large collections.
    # A simpler approach for new IDs is to use file_path + chunk_index, but requires careful handling of updates.
    # Using a counter based on initial collection size for this run.
    # For "full" re-index, this should start from 0 if collection was truly cleared.
    # If collection was not fully cleared (e.g. delete by IDs failed), this might lead to ID collisions.
    # A UUID for each chunk is safer: `str(uuid.uuid4())`
    doc_id_offset = 0
    if mode == "update": # Get current count to offset new IDs
        try:
            doc_id_offset = collection.count()
        except Exception:
            doc_id_offset = int(time.time()) # Fallback to time-based offset if count fails

    processed_file_count = 0
    with ProcessPoolExecutor(max_workers=os.cpu_count()) as executor:
        future_to_file = {
            executor.submit(process_file_for_chunks_and_embeddings, f_path, root_path): f_path
            for f_path, root_path in files_to_process_map.items()
        }
        for future in as_completed(future_to_file):
            file_path_str = future_to_file[future]
            try:
                processed_results = future.result()
                for embedding, metadata in processed_results:
                    all_embeddings.append(embedding)
                    all_metadatas.append(metadata)
                    # Using file path and start line for a more stable ID if re-indexing,
                    # but simple counter for now. For production, use UUIDs or hash of content.
                    all_ids.append(f"doc_{doc_id_offset}_{len(all_ids)}")
            except Exception as exc:
                print_json_output("error", f'{file_path_str} generated an exception: {exc}')
            
            processed_file_count += 1
            if processed_file_count % 10 == 0 or processed_file_count == len(files_to_process_map):
                print_json_output("progress", f"Embedding: {processed_file_count}/{len(files_to_process_map)} files",
                                  percentage=40 + int(50 * processed_file_count/len(files_to_process_map)))


    if all_embeddings:
        print_json_output("info", f"Adding {len(all_embeddings)} new chunk embeddings to ChromaDB...")
        batch_size = 500 # Reduced batch size for potentially less memory usage
        for i in range(0, len(all_embeddings), batch_size):
            try:
                collection.add(
                    embeddings=all_embeddings[i:i+batch_size],
                    metadatas=all_metadatas[i:i+batch_size],
                    ids=all_ids[i:i+batch_size]
                )
            except Exception as e:
                print_json_output("error", f"Error adding batch to ChromaDB (IDs: {all_ids[i]}...): {e}")
            
            current_progress_in_batching = i + len(all_embeddings[i:i+batch_size])
            print_json_output("progress", f"Adding to DB: {current_progress_in_batching}/{len(all_embeddings)} chunks",
                              percentage=90 + int(10 * current_progress_in_batching/len(all_embeddings)))

        print_json_output("completed", "Codebase indexing complete.",
                          db_path=str(chroma_db_path_obj),
                          project_path=project_dir_str,
                          new_chunks_added=len(all_embeddings),
                          total_chunks_in_db=collection.count())
        save_last_index_meta(chroma_db_path_obj, project_dir_str, time.time())
    else:
        print_json_output("info", "No new embeddings were generated to add.")
        # Still save meta if in update mode and some files were scanned, to update timestamp
        if mode == "update":
            save_last_index_meta(chroma_db_path_obj, project_dir_str, time.time())

    print_json_output("info", f"Collection '{collection.name}' now has {collection.count()} items.")


def query_and_get_context_files(query_text, project_dir_str, chroma_db_dir_str, top_k_files=TOP_K_FILES_TO_RETRIEVE):
    chroma_db_path_obj = Path(chroma_db_dir_str).resolve()
    project_path_obj = Path(project_dir_str).resolve()

    last_meta = load_last_index_meta(chroma_db_path_obj)
    if not Path(chroma_db_path_obj).exists() or not last_meta or last_meta.get("project_path") != str(project_path_obj) :
        print_json_output("error", "Database not found or not indexed for the current project.", db_path=str(chroma_db_path_obj), expected_project=str(project_path_obj), actual_project_in_db=last_meta.get("project_path"))
        return []

    client = chromadb.PersistentClient(path=str(chroma_db_path_obj))
    try:
        collection = client.get_collection(name=CHROMA_COLLECTION_NAME)
    except Exception as e:
        print_json_output("error", f"Could not connect to ChromaDB collection for query: {e}")
        return []

    query_embedding_list = get_ollama_embedding([query_text])
    if not query_embedding_list or not query_embedding_list[0]:
        print_json_output("error", "Could not generate query embedding. Aborting.")
        return []
    query_embedding = query_embedding_list[0]

    try:
        num_chunks_to_retrieve = top_k_files * 5  # You might want to adjust this based on typical chunk density
        results = collection.query(
            query_embeddings=[query_embedding],
            n_results=num_chunks_to_retrieve,
            include=['metadatas', 'documents', 'distances'] # <<< MODIFICATION 1: Added 'distances'
        )
    except Exception as e:
        print_json_output("error", f"Error querying ChromaDB: {e}")
        return []

    # It's good practice to check if results and essential fields are present
    if not results or \
       not results.get('ids') or not results['ids'][0] or \
       not results.get('metadatas') or not results['metadatas'][0]:
        # If no results, or metadatas are missing, likely no useful data to process
        # print_json_output("info", "Query returned no matching results or insufficient data.")
        return []


    file_scores = {}
    file_chunks_map = {}

    # <<< MODIFICATION 2: More robust extraction of distances
    actual_distances_list = []
    # results.get('distances') could return None if key 'distances' exists with value None,
    # or it could return the list of lists of distances e.g. [[0.1, 0.2, ...]]
    # or it could be absent if not included (but we included it).
    distances_data_from_results = results.get('distances')
    if distances_data_from_results and \
       isinstance(distances_data_from_results, list) and \
       len(distances_data_from_results) > 0:
        # We expect one list of distances because we sent one query_embedding
        if isinstance(distances_data_from_results[0], list):
            actual_distances_list = distances_data_from_results[0]
        # else: print_json_output("warning", "Distances data from ChromaDB is not in the expected format (List[List[float]]).")
    # else: print_json_output("warning", "No distances data found in ChromaDB results or it's empty.")


    # Ensure metadatas and documents are also handled robustly if they can be None or malformed
    metadatas_list = results['metadatas'][0] if results.get('metadatas') and results['metadatas'] else []
    documents_list = results['documents'][0] if results.get('documents') and results['documents'] else []

    # Ensure we iterate up to the minimum length of available metadata, documents, and potentially distances
    num_items_to_process = len(metadatas_list)


    for i in range(num_items_to_process):
        metadata_item = metadatas_list[i]
        if not (metadata_item and 'source_file' in metadata_item):
            # print_json_output("warning", f"Skipping item {i} due to missing metadata or source_file.")
            continue

        file_path = metadata_item['source_file']
        current_score = 0.0

        # Use the actual_distances_list for scoring
        if actual_distances_list and i < len(actual_distances_list) and actual_distances_list[i] is not None:
            # We have a valid distance for this item
            try:
                # Ensure distance is a float before arithmetic
                distance_value = float(actual_distances_list[i])
                current_score = 1.0 / (distance_value + 1e-6)
            except (ValueError, TypeError):
                # Fallback if distance is not a valid number
                # print_json_output("warning", f"Invalid distance value for item {i}: {actual_distances_list[i]}. Using fallback score.")
                current_score = float(num_chunks_to_retrieve - i)
        else:
            # Fallback: No valid distance or actual_distances_list is empty/shorter
            current_score = float(num_chunks_to_retrieve - i) # Using rank as a proxy for score

        if file_path not in file_scores:
            file_scores[file_path] = 0.0 # Initialize with float
            file_chunks_map[file_path] = []

        file_scores[file_path] += current_score
        
        document_text = documents_list[i] if i < len(documents_list) else metadata_item.get("original_chunk_text_preview", "")

        chunk_info = {
            "text": document_text,
            "start_line": metadata_item.get("start_line"),
            "end_line": metadata_item.get("end_line"),
            "score": current_score # Use the calculated score for this chunk
        }
        file_chunks_map[file_path].append(chunk_info)

    sorted_files = sorted(file_scores.items(), key=lambda item: item[1], reverse=True)

    retrieved_file_contents = []
    for file_path_str, total_score in sorted_files[:top_k_files]:
        try:
            with open(file_path_str, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
            retrieved_file_contents.append({
                "file_path": file_path_str,
                "content": content,
                "relevance_score": total_score,
                # "chunks": sorted(file_chunks_map.get(file_path_str, []), key=lambda c: c['score'], reverse=True) # Optional: include chunks
            })
        except Exception as e:
            print_json_output("warning", f"Error reading file {file_path_str} during context retrieval: {e}")
            
    return retrieved_file_contents


if __name__ == "__main__":
    import sys # For sys.stdout.flush()

    parser = argparse.ArgumentParser(description="Codebase indexer and querier for Gemini Coder.")
    parser.add_argument("--project-dir", type=str, required=True, help="The absolute path to the project directory to index.")
    parser.add_argument("--db-parent-dir", type=str, default=str(DEFAULT_CHROMA_DB_PARENT_DIR),
                        help=f"The parent directory where the ChromaDB named '{DEFAULT_CHROMA_DB_NAME}' will be stored/found. Defaults to gemini-coder/vector_stores/.")
    parser.add_argument("--action", choices=["index", "query", "get_last_indexed_time"], required=True, help="Action to perform.")
    parser.add_argument("--mode", choices=["full", "update"], default="update", help="Indexing mode (full re-index or update).")
    parser.add_argument("--query-text", type=str, help="Text to query for relevant context (required if action is query).")

    args = parser.parse_args()

    # Construct the specific ChromaDB path for this project
    # For now, we use a single global DB path as per original simplified request.
    # If multiple projects need separate DBs, db_parent_dir should be used to create project-specific subdirs.
    # For now, db_parent_dir directly contains "codedb_chroma_ts"
    
    # The user requested a single DB folder `gemini-coder/<folder-name>`, let's use `vector_stores/codedb_chroma_ts`
    # So, db_parent_dir is effectively the `gemini-coder` root, and the folder name is `vector_stores`.
    # The actual DB path will be `db_parent_dir / "codedb_chroma_ts"`
    
    # Let db_parent_dir be the "vector_stores" dir itself.
    # So, CHROMA_DB_PATH = vector_stores/codedb_chroma_ts
    chroma_db_actual_path = Path(args.db_parent_dir) / DEFAULT_CHROMA_DB_NAME
    chroma_db_actual_path.mkdir(parents=True, exist_ok=True) # Ensure parent dir exists

    if args.action == "index":
        try:
            index_codebase(args.project_dir, str(chroma_db_actual_path), args.mode)
        except Exception as e:
            import traceback
            print_json_output("error", f"Unhandled exception during indexing: {e}\n{traceback.format_exc()}")
            sys.exit(1)

    elif args.action == "query":
        if not args.query_text:
            print_json_output("error", "Argument --query-text is required for action 'query'.")
            sys.exit(1)
        try:
            context_files = query_and_get_context_files(args.query_text, args.project_dir, str(chroma_db_actual_path))
            # Output the result as a single JSON line for Node.js to parse
            print(json.dumps({"type": "query_result", "files": context_files}))
        except Exception as e:
            import traceback
            print_json_output("error", f"Unhandled exception during query: {e}\n{traceback.format_exc()}")
            sys.exit(1)
            
    elif args.action == "get_last_indexed_time":
        meta = load_last_index_meta(chroma_db_actual_path)
        if meta.get("project_path") == args.project_dir and meta.get("timestamp", 0) > 0:
             print_json_output("last_indexed_time", 
                               message=f"Last indexed on {time.ctime(meta['timestamp'])}",
                               timestamp=meta['timestamp'],
                               project_path=meta['project_path'])
        else:
            print_json_output("last_indexed_time",
                               message="Not indexed for this project or never.",
                               timestamp=0,
                               project_path=args.project_dir) # Report project path for UI
    else:
        print_json_output("error", f"Unknown action: {args.action}")
        sys.exit(1)
    
    sys.exit(0)