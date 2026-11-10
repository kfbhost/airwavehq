const TOKEN_KEY = "airshift_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
}

export interface UploadOptions {
  onProgress?: (loaded: number, total: number) => void;
  onProcessing?: () => void;
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    if (opts.body instanceof FormData) {
      body = opts.body;
    } else if (typeof opts.body === "string") {
      body = opts.body;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
  }

  const res = await fetch(`/api${path}`, {
    method: opts.method ?? "GET",
    headers,
    body,
  });
  if (res.status === 401) {
    setToken(null);
    if (!path.startsWith("/auth/")) window.location.href = "/login";
    throw new ApiError(401, "Unauthorized");
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: unknown };
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const upload = async (path: string, form: FormData, opts: UploadOptions = {}): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api${path}`);
    const token = getToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        opts.onProgress?.(event.loaded, event.total);
      }
    });
    xhr.upload.addEventListener("load", () => {
      opts.onProcessing?.();
    });
    xhr.addEventListener("load", () => {
      if (xhr.status === 401) {
        setToken(null);
        if (!path.startsWith("/auth/")) window.location.href = "/login";
        reject(new ApiError(401, "Unauthorized"));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        const data = JSON.parse(xhr.responseText || "{}") as { error?: string };
        reject(new ApiError(xhr.status, data.error ?? "Upload failed"));
        return;
      }
      try {
        resolve(JSON.parse(xhr.responseText || "null"));
      } catch {
        resolve(null);
      }
    });
    xhr.addEventListener("error", () => reject(new ApiError(0, "Upload failed")));
    xhr.send(form);
  });
