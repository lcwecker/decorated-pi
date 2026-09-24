/**
 * `file://` URI ↔ absolute path, in one place.
 *
 * `textDocument/rename` answers with URIs, the filesystem needs paths, and the
 * result text wants a readable form again. Both directions live here so the
 * client and the formatters cannot disagree about how a URI maps to a file.
 */
import { fileURLToPath, pathToFileURL } from "node:url";

/** A `file:` URI becomes an absolute path; anything else is returned verbatim. */
export function uriToFilePath(uri: string): string {
  try {
    return uri.startsWith("file:") ? fileURLToPath(uri) : uri;
  } catch {
    return uri;
  }
}

export function filePathToUri(filePath: string): string {
  return pathToFileURL(filePath).href;
}

/** True when the path came from a `file:` URI and is therefore on disk. */
export function isLocalFilePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}
