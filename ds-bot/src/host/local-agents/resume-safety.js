// Port of classifyResumeFailure from OpenMausBot (server/resume-recovery.ts), Apache-2.0. See NOTICE.

/**
 * @typedef {'before-accept' | 'after-accept' | 'unknown'} ResumeClassification
 */

/**
 * @param {{ attempted: boolean, rejected: boolean, promptSubmitted: boolean, producedOutput: boolean }} state
 * @returns {ResumeClassification}
 */
export function classifyResumeFailure({ attempted, rejected, promptSubmitted, producedOutput }) {
  if (producedOutput || promptSubmitted) return 'after-accept'
  if (attempted && rejected) return 'before-accept'
  return 'unknown'
}

/** @param {ResumeClassification} classification */
export function mayReplay(classification) {
  return classification === 'before-accept'
}
