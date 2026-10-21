export function parseTags(input: string, existing: string[] = []): string[] {
  const normalized = input.split(',').flatMap((group) => {
    const matches = [...group.matchAll(/(?:^|\s)#([^\s#]+)/g)]
    if (!matches.length) return [group.trim().replace(/^#+/, '').trim().replace(/\s+/g, '_')].filter(Boolean)
    const tags = matches.map((match) => match[1]!)
    const prefix = group.slice(0, matches[0]!.index).trim().replace(/\s+/g, '_')
    return prefix ? [prefix, ...tags] : tags
  })
  const tags = new Map<string, string>()
  for (const tag of [...existing, ...normalized]) {
    const key = tag.toLocaleLowerCase('ru')
    if (!tags.has(key)) tags.set(key, tag)
  }
  return [...tags.values()]
}
