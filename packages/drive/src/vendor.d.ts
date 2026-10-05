declare module 'compact-encoding' {
  export interface EncodingState {
    start: number
    end: number
    buffer: Uint8Array | null
  }
  export interface Encoding<T> {
    preencode(state: EncodingState, value: T): void
    encode(state: EncodingState, value: T): void
    decode(state: EncodingState): T
  }
  export const json: unknown
  export const string: Encoding<string>
  export const uint: Encoding<number>
  export const raw: Encoding<Uint8Array>
  export function encode<T>(encoding: Encoding<T>, value: T): Uint8Array
  export function decode<T>(encoding: Encoding<T>, buffer: Uint8Array): T
  const _default: {
    json: typeof json
    string: typeof string
    uint: typeof uint
    raw: typeof raw
    encode: typeof encode
    decode: typeof decode
  }
  export default _default
}
