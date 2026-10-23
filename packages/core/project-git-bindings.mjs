import path from "node:path";

// The legacy primary mapping remains readable; additional roots never inherit it.
export function projectGitBindings(project) {
  const byRoot = new Map();
  for (const binding of [project.gitBinding, ...(project.gitBindings ?? [])]) {
    if (binding?.sourceRoot) byRoot.set(path.resolve(binding.sourceRoot), binding);
  }
  return [...byRoot.values()];
}
export function projectGitBinding(project, root) {
  return projectGitBindings(project).find(binding => path.resolve(binding.sourceRoot) === path.resolve(root)) ?? null;
}
export function saveProjectGitBinding(project, binding) {
  const bindings = projectGitBindings(project).filter(entry => path.resolve(entry.sourceRoot) !== path.resolve(binding.sourceRoot));
  project.gitBindings = [...bindings, binding];
  // Maintain existing clients' primary mapping without changing it on another root.
  if (!project.gitBinding || path.resolve(project.gitBinding.sourceRoot) === path.resolve(binding.sourceRoot)) project.gitBinding = binding;
  return binding;
}
