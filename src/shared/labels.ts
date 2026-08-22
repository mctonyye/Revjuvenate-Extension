export const ACTION_LABELS: Record<string, string> = {
  goto: 'Navigate to URL',
  back: 'Go back',
  forward: 'Go forward',
  click_navigate: 'Click to navigate',
  wait_for_url: 'Wait for URL',
  click: 'Click',
  js_click: 'Click (JS)',
  double_click: 'Double click',
  hover: 'Hover',
  hover_with_offset: 'Hover (offset)',
  press_key: 'Press key',
  drag_and_drop: 'Drag & drop',
  input: 'Type value',
  type: 'Type value',
  type_slowly: 'Type slowly',
  clear: 'Clear field',
  select: 'Select option',
  custom_select: 'Select (custom)',
  check_uncheck: 'Check / uncheck',
  custom_check_uncheck_daylight: 'Check / uncheck (daylight)',
  input_activate_deactivate: 'Activate / deactivate',
  replace_click: 'Replace & click',
  upload_file: 'Upload file',
  select_from_list: 'Select from list',
  double_click_from_list: 'Double click from list',
  multi_check_uncheck_from_checkboxes: 'Check / uncheck (checkboxes)',
  list_activate_deactivate: 'List activate / deactivate',
  get_text: 'Read text',
  get_attribute: 'Read attribute',
  get_url: 'Read URL',
  get_n_keep_values: 'Read & keep values',
  get_n_keep_values1: 'Read & keep values (1)',
  get_n_keep_ids: 'Read & keep IDs',
  check_exists: 'Check exists',
  check_visible: 'Check visible',
  accept_dialog: 'Accept dialog',
  dismiss_dialog: 'Dismiss dialog',
  wait: 'Wait',
  scroll: 'Scroll',
  scroll_to_top: 'Scroll to top',
  scroll_to_bottom: 'Scroll to bottom',
  scroll_to_element: 'Scroll to element',
  scroll_up_page: 'Scroll up a page',
  scroll_down_page: 'Scroll down a page',
  screenshot: 'Screenshot',
  evaluate_js: 'Run JS',
  assert: 'Assert',
  loop: 'Loop',
  wait_until_page_ready: 'Wait for page ready',
  wait_until_element_ready: 'Wait for element ready',
}

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action
}

/** Combined step display label: the step's original name (element_name),
 *  followed by its action label, e.g. "Login submit — Click". */
export function stepLabel(step: { action: string; element_name?: string }): string {
  const label = actionLabel(step.action)
  return step.element_name ? `${step.element_name} — ${label}` : label
}
