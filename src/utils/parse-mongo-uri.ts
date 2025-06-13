import { URLSearchParams } from 'url';

export function parseMongoUri(uri: string): {
  user?: string;
  password?: string;
  hosts: { host: string; port: number }[];
  database?: string;
  options: Record<string, string>;
} {
  const mongoUriRegex = /^mongodb:\/\/(?:([^:]+)(?::([^@]+))?@)?([^/?]+)(?:\/([^?]+))?(?:\?(.+))?$/;
  let match = uri.match(mongoUriRegex);

  if (!match) {
    const uriWithSlash = uri.includes('?') && !uri.includes('/?') ? uri.replace('?', '/?') : uri;
    const fallbackMatch = uriWithSlash.match(mongoUriRegex);
    if (!fallbackMatch) {
      // Consider using logger here if available globally or passed
      console.error('Failed to parse URI with regex:', uri);
      throw new Error('Invalid MongoDB URI format');
    }
    // Consider using logger here
    console.warn('Parsed URI using fallback with added slash.');
    match = fallbackMatch;
  }

  const [, user, password, hostString, database, optionString] = match!;

  const hosts = hostString.split(',').map((hostPort) => {
    const parts = hostPort.split(':');
    const host = parts[0];
    const port = parseInt(parts[1] || '27017', 10);
    if (isNaN(port)) {
      throw new Error(`Invalid port number in host string: ${hostPort}`);
    }
    return { host, port };
  });

  const options: Record<string, string> = {};
  if (optionString) {
    const params = new URLSearchParams(optionString);
    params.forEach((value, key) => {
      options[key] = value;
    });
  }

  return {
    user: user ? decodeURIComponent(user) : undefined,
    password: password ? decodeURIComponent(password) : undefined,
    hosts,
    database: database ? database.split('/')[0] : undefined,
    options,
  };
}
