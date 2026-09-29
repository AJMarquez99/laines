import { MalformedConfigError } from './errors.js';

export function parseWith(schema, data, file) {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const detail = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  throw new MalformedConfigError(file, detail);
}
