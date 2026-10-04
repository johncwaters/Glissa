export const frontmatterBlockPattern = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/

export function readFrontmatter(fileText) {
  const frontmatterMatch = frontmatterBlockPattern.exec(fileText)
  if (!frontmatterMatch) throw new Error('Missing frontmatter block')
  const fields = {}
  const frontmatterLines = (frontmatterMatch[1] ?? '').split(/\r?\n/)
  frontmatterLines.forEach((frontmatterLine, lineIndex) => {
    if (!frontmatterLine) return
    const fieldMatch = /^([^:\s][^:]*):\s*(.*)$/.exec(frontmatterLine)
    if (!fieldMatch) throw new Error(`Malformed frontmatter on line ${lineIndex + 2}`)
    const [, fieldName, fieldValue] = fieldMatch
    if (Object.hasOwn(fields, fieldName)) throw new Error(`Duplicate frontmatter key: ${fieldName}`)
    fields[fieldName] = fieldValue
  })
  const frontmatterEndOffset = frontmatterMatch.index + frontmatterMatch[0].length
  return { fields, bodyText: fileText.slice(frontmatterEndOffset), firstBodyLineNumber: frontmatterMatch[0].split(/\r?\n/).length }
}
