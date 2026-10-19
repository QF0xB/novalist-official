import type { Node as ModelNode } from 'prosemirror-model'
import { sceneSchema } from './schema.ts'

/**
 * A scene file's body (after the identity line) in format version 1:
 *
 *   {"format":"novalist-scene","version":1,"doc":{"type":"doc","content":[
 *   {"type":"paragraph",...},
 *   {"type":"paragraph",...}
 *   ]}}
 *
 * One top-level block per line, so Git diffs and conflicts stay per paragraph.
 */
export const SCENE_FORMAT = 'novalist-scene'
export const SCENE_FORMAT_VERSION = 1

export class SceneFormatError extends Error {}

/** True when a scene body is a scene document rather than legacy HTML. */
export function isSceneDocument(body: string): boolean {
  return /^\s*\{/.test(body)
}

type NodeJson = { type: string; attrs?: Record<string, unknown>; marks?: NodeJson[]; content?: NodeJson[]; text?: string }

/** Drops attributes at their default value; parsing restores them. */
function compact(json: NodeJson, defaults: (type: string) => Record<string, unknown>): NodeJson {
  const result: NodeJson = { ...json }
  if (json.attrs) {
    const own = defaults(json.type)
    const attrs = Object.fromEntries(Object.entries(json.attrs).filter(([name, value]) =>
      JSON.stringify(value) !== JSON.stringify(own[name])))
    if (Object.keys(attrs).length) result.attrs = attrs
    else delete result.attrs
  }
  if (json.marks) result.marks = json.marks.map(mark => compact(mark, markDefaults))
  if (json.content) result.content = json.content.map(child => compact(child, nodeDefaults))
  return result
}

const defaultsOf = (spec: { attrs?: Record<string, { default?: unknown }> } | undefined) =>
  Object.fromEntries(Object.entries(spec?.attrs ?? {}).map(([name, attr]) => [name, attr.default]))
const nodeDefaults = (type: string) => defaultsOf(sceneSchema.nodes[type]?.spec)
const markDefaults = (type: string) => defaultsOf(sceneSchema.marks[type]?.spec)

export function serializeScene(doc: ModelNode): string {
  const blocks = doc.content.content.map(block => JSON.stringify(compact(block.toJSON() as NodeJson, nodeDefaults)))
  const head = JSON.stringify({ format: SCENE_FORMAT, version: SCENE_FORMAT_VERSION })
  return `${head.slice(0, -1)},"doc":{"type":"doc","content":[\n${blocks.join(',\n')}\n]}}\n`
}

/** Parses and validates a scene body against the schema. */
export function parseScene(body: string): ModelNode {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch (error) {
    throw new SceneFormatError(`Scene is not valid JSON: ${(error as Error).message}`)
  }
  const file = value as { format?: unknown; version?: unknown; doc?: unknown }
  if (file?.format !== SCENE_FORMAT) throw new SceneFormatError('Not a Novalist scene document')
  if (file.version !== SCENE_FORMAT_VERSION) {
    throw new SceneFormatError(`Unsupported scene format version ${String(file.version)}`)
  }
  try {
    const doc = sceneSchema.nodeFromJSON(file.doc)
    doc.check()
    return doc
  } catch (error) {
    throw new SceneFormatError(`Scene document does not match the schema: ${(error as Error).message}`)
  }
}
