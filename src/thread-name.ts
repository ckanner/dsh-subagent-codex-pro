import { basename } from 'node:path'

/** Name from an explicit task label or workspace only, never from the complete prompt. */
export function readableThreadName(label: string | undefined, cwd: string): string {
  const clean = (label ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  const fallback = `DSH · ${basename(cwd) || 'workspace'} · Codex delegation`
  return [...(clean || fallback)].slice(0, 160).join('')
}
