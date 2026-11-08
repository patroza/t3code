export function threadWebUrl(httpBaseUrl: string, threadId: string): string {
  const url = new URL(httpBaseUrl);
  url.pathname = "/";
  url.search = "";
  url.searchParams.set("thread", threadId);
  url.hash = "";
  return url.toString();
}
