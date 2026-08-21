/**
 * Shared path comparison for workspace matching and containment checks.
 * Identity only — does not resolve relative segments.
 */
export function normalizePath(path) {
    const unified = path.replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? unified.toLowerCase() : unified;
}
export function pathsEqual(left, right) {
    return normalizePath(left) === normalizePath(right);
}
