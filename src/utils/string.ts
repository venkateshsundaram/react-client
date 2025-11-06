export function pascalCase(s: string) {
  return s.replace(/(^|[-_/\s]+)([a-zA-Z])/g, (_, __, ch) => ch.toUpperCase());
}
