// A small JSON Schema checker for the manifests' upstream schemas
// (tests/schemas/): the subset of draft-07 and 2020-12 those schemas use.
// Zero dependencies, like the package. An unknown keyword throws, so a
// schema update that needs more than this subset fails loudly instead of
// passing unchecked.

const ANNOTATIONS = new Set([
  '$schema', '$id', '$comment', 'title', 'description', 'default', 'example', 'examples', 'definitions', '$defs',
  'deprecated', 'readOnly', 'writeOnly',
]);
const KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'enum', 'const', 'pattern', 'minLength', 'maxLength',
  'items', 'minItems', 'maxItems', 'oneOf', 'anyOf', 'allOf', 'not', 'propertyNames', '$ref', 'format',
  'minimum', 'maximum',
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const typeOf = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

function matchesType(value, type) {
  switch (type) {
    case 'object': return isObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    default: throw new Error(`unsupported type ${type}`);
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (isObject(a)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#')) throw new Error(`only local $ref is supported: ${ref}`);
  let node = root;
  for (const raw of ref.slice(1).split('/').filter(Boolean)) {
    const part = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(node) || !Object.hasOwn(node, part)) throw new Error(`unresolved $ref ${ref}`);
    node = node[part];
  }
  return node;
}

function checkFormat(value, format) {
  if (typeof value !== 'string') return true;
  switch (format) {
    case 'uri':
      try { return /^[a-z][a-z0-9+.-]*:/i.test(value) && Boolean(new URL(value)); } catch { return false; }
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    default:
      throw new Error(`unsupported format ${format}`);
  }
}

const length = (text) => [...text].length;

/**
 * Problems with `value` under `schema`, as "path: message" strings; empty when it's valid.
 * @param {object|boolean} schema
 * @param {unknown} value
 * @param {{root?: object, path?: string}} [context]
 * @returns {string[]}
 */
export function validate(schema, value, { root = schema, path = '$' } = {}) {
  if (schema === true) return [];
  if (schema === false) return [`${path}: not allowed`];
  if (!isObject(schema)) throw new Error(`schema at ${path} is not an object`);
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) throw new Error(`unsupported keyword ${key} at ${path}`);
  }
  const problems = [];
  const at = (suffix) => ({ root, path: `${path}${suffix}` });

  if (schema.$ref !== undefined) problems.push(...validate(resolveRef(root, schema.$ref), value, { root, path }));
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      return [...problems, `${path}: expected ${types.join(' or ')}, got ${typeOf(value)}`];
    }
  }
  if (schema.const !== undefined && !deepEqual(value, schema.const)) problems.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum !== undefined && !schema.enum.some((option) => deepEqual(value, option))) {
    problems.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && length(value) < schema.minLength) problems.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && length(value) > schema.maxLength) problems.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) problems.push(`${path}: does not match ${schema.pattern}`);
    if (schema.format !== undefined && !checkFormat(value, schema.format)) problems.push(`${path}: not a valid ${schema.format}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items !== undefined) value.forEach((item, i) => problems.push(...validate(schema.items, item, at(`[${i}]`))));
  }
  if (isObject(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) problems.push(`${path}: missing ${key}`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (schema.propertyNames !== undefined) problems.push(...validate(schema.propertyNames, key, at(`{${key}}`)));
      if (Object.hasOwn(properties, key)) {
        problems.push(...validate(properties[key], child, at(`.${key}`)));
      } else if (schema.additionalProperties !== undefined) {
        problems.push(...validate(schema.additionalProperties, child, at(`.${key}`)));
      }
    }
  }
  for (const sub of schema.allOf ?? []) problems.push(...validate(sub, value, { root, path }));
  if (schema.anyOf !== undefined && !schema.anyOf.some((sub) => validate(sub, value, { root, path }).length === 0)) {
    problems.push(`${path}: matches none of anyOf`);
  }
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((sub) => validate(sub, value, { root, path }).length === 0).length;
    if (matches !== 1) problems.push(`${path}: matches ${matches} of oneOf, not exactly one`);
  }
  if (schema.not !== undefined && validate(schema.not, value, { root, path }).length === 0) problems.push(`${path}: matches not`);
  return problems;
}
