// The rule the reference relay (chel) checks registered names against, such
// as usernames. It's shared so that an app can reject a bad name before
// sending anything, instead of waiting for the relay's HTTP 400.
//
// - 1 to 80 characters: lowercase letters, digits, `_` and `-`
// - can't start or end with `_` or `-`
// - no `__` or `--`
//
// Checked as safe from ReDoS with <https://devina.io/redos-checker>
const NAME_REGEX = /^(?![_-])((?!([_-])\2)[a-z\d_-]){1,80}(?<![_-])$/

// The `typeof` check is for callers without types: `test` turns its argument
// into a string, and 'undefined' is a valid name.
export const isValidName = (name: string): boolean =>
  typeof name === 'string' && NAME_REGEX.test(name)
