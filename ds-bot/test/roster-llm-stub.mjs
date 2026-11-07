// Stand-in for the one symbol delivery.js imports. Not a harness package.
export function createUserMessage(content) {
  return { role: 'user', content: content ?? '' }
}
