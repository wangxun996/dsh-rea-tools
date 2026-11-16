/**
 * Which REA tools get a direct DSH registration.
 *
 * The upstream catalog has 255 tools — registering all of them would put tens
 * of thousands of tokens of JSON Schema in front of every request. The tools
 * below are the entry points that cover the common flows (native binary,
 * archive/app artifact, JavaScript/Electron, web page, Android package,
 * guidance, evidence export); everything else stays reachable through the
 * `rea_tools` / `rea_call` gateway.
 *
 * Override with the plugin config: `directTools: "all" | "none" | [names…]`.
 */
export const DEFAULT_DIRECT_TOOLS = [
  'open_binary',
  'binary_session',
  'binary_overview',
  'procedure_pseudo_code',
  'analyze_function',
  'search_strings',
  'inspect_native_exports',
  'inspect_artifact',
  'inspect_managed_artifact',
  'analyze_javascript_application',
  'inspect_web_page',
  'inspect_android_package',
  'search_guidance',
  'guided_workflows',
  'export_evidence_bundle',
  'close_binary',
]
