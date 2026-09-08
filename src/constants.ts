export const INVITE_STATUS = {
  REVOKED: 'revoked',
  VALID: 'valid',
  USED: 'used'
}

// An invite's `meta.quantity` is the number of times it may be used. It is
// optional: an invite without one is unlimited, which `OP_KEY_REQUEST`
// processing supports deliberately. When one *is* present it has to be a
// number an invite can actually honour, so authoring (`expandKeySpecs`) and
// processing (`keyAdditionProcessor`) agree on this single predicate rather
// than each inventing its own idea of 'malformed'.
export const isValidInviteQuantity = (quantity: unknown): quantity is number =>
  typeof quantity === 'number' &&
  Number.isSafeInteger(quantity) &&
  quantity > 0
