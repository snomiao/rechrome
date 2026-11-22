/** npm <=11 returns an array; npm12 returns a map keyed by package name. */
function packedFiles(text) {
  const value = JSON.parse(text);
  const packages = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
  if (packages.length !== 1 || !packages[0] || !Array.isArray(packages[0].files) || !packages[0].files.length || packages[0].files.some(file => !file || typeof file.path !== 'string' || !file.path)) {
    throw new Error('check-pack: npm pack returned no unambiguous file manifest');
  }
  return packages[0].files.map(file => file.path.replace(/\\/g, '/'));
}
module.exports = { packedFiles };
