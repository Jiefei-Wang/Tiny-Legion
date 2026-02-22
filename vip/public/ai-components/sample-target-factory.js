export function buildAiComponentSpec(args) {
  const params = args && typeof args === "object" && args.params && typeof args.params === "object"
    ? args.params
    : {};
  return {
    familyId: "neural-target",
    params,
  };
}
