export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function validateStringFields(inputFields, allowedFieldNames, { inputName, ErrorType = Error }) {
  const fieldNames = Object.keys(inputFields)
  const unknownFieldNames = fieldNames.filter((fieldName) => !allowedFieldNames.has(fieldName))
  if (unknownFieldNames.length > 0) throw new ErrorType(`Unknown ${inputName.toLowerCase()} fields: ${unknownFieldNames.join(', ')}`)
  const nonStringFieldNames = fieldNames.filter((fieldName) => typeof inputFields[fieldName] !== 'string')
  if (nonStringFieldNames.length > 0) throw new ErrorType(`${inputName} fields must be strings: ${nonStringFieldNames.join(', ')}`)
  return fieldNames
}
