export const WORKSPACE_TABS: Array<[string,string]>;
export function workspaceTabMarkup(tab:string):string;
export function workspaceAssessmentMarkup(assessment:unknown,options?:{refreshable?:boolean;entryTab?:"explore"|"tasks"}):string;
export type WorkspaceViewOptions = {
  selectedTaskId?: string;
  taskContext?: unknown;
  canEdit?: boolean;
  isBusy?: boolean;
  canPrepareHandoff?: boolean;
  selectedStatus?: string | null;
};
export function workspaceTaskDetailMarkup(task:unknown,context?:unknown,options?:WorkspaceViewOptions):string;
export function workspaceReleaseMarkup(release?:unknown,projectFilter?:string):string;
export function workspaceViewMarkup(model:unknown,tab?:string,projectFilter?:string,options?:WorkspaceViewOptions):string;
