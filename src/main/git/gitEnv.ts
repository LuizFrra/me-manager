/**
 * Git variables that would redirect git to another repository (they are set inside git hooks and
 * some terminals). Setting them to undefined removes them from the child's environment.
 */
export const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_PREFIX: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_NAMESPACE: undefined,
  GIT_EXTERNAL_DIFF: undefined,
}
