export async function api<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${route}`, {
    method: body === undefined ? "GET" : "POST", credentials: "same-origin",
    headers: { "X-Studio-Request": "1", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "The request could not complete.");
  return result as T;
}

export async function connect() {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (token) {
    history.replaceState(null, "", location.pathname + location.search);
    await api("session", { token });
  }
}

export function download(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
