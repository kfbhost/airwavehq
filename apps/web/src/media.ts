/**
 * Builds browser URLs for files in the API's media folder.
 *
 * Tracks store absolute paths (`artwork_path`, `file_path`), and on Windows
 * those arrive with backslashes — `C:\Users\...\data\media\<uuid>.mp3`.
 * Splitting such a path on "/" alone leaves the whole string intact, so the
 * browser asked for `/media/C:\Users\...` and the cover or audio preview
 * 404'd. Only the basename is ever public: `/media/` is a static mount of the
 * data folder on the API, so anything before the last separator must go.
 */
export function mediaUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  const name = path.split(/[\\/]/).pop();
  return name ? `/media/${encodeURIComponent(name)}` : null;
}
