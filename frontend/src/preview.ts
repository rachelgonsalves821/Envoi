export function previewRequested(search: string, development: boolean) {
  return development && new URLSearchParams(search).has('preview');
}
