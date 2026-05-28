// Minimal ambient declaration for uuid@8 (which does not ship its own types)
declare module 'uuid' {
  export function v4(): string
  export function v1(): string
  export function v5(name: string, namespace: string): string
  export function validate(uuid: string): boolean
  export function version(uuid: string): number
}
