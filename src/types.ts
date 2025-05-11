/* eslint-disable no-use-before-define */

export type JSONType =
    | string
    | number
    | boolean
    | JSONObject
    | JSONArray;
export interface JSONObject {
  [x: string]: JSONType;
}
export type JSONArray = Array<JSONType>;

export type ResType =
  | ResTypeErr | ResTypeOK | ResTypeAlready
  | ResTypeSub | ResTypeUnsub | ResTypeEntry | ResTypePub
export type ResTypeErr = 'error'
export type ResTypeOK = 'success'
export type ResTypeAlready = 'already'
export type ResTypeSub = 'sub'
export type ResTypeUnsub = 'unsub'
export type ResTypePub = 'pub'
export type ResTypeEntry = 'entry'

// NOTE: If Flow isn't making any sense try changing this from a type to an interface!
// https://github.com/facebook/flow/issues/3041
export type Response = {
// export interface Response {
  type: ResType;
  err?: string;
  data?: JSONType
}
export type ChelKvOnConflictCallback = (
  args: { contractID: string, key: string, failedData: JSONType, status: number, etag: string | null | undefined, currentData: JSONType, currentValue: JSONType }
) => Promise<[JSONType, string]>
