/**
 * What a Setup or pairing form says before it asks the service: one message per field, in the order the fields appear,
 * so the form can name each problem beside its field and put focus in the first.
 */

export interface FieldProblem<F extends string> {
  field: F;
  message: string;
}

/** A pairing code is 8 letters and digits; spaces and dashes are ignored, as the service ignores them. */
const PAIRING_CODE_LENGTH = 8;

export function pairingCodeProblem(code: string): string | null {
  const plain = code.replace(/[\s-]/g, "");
  if (!plain) return "Enter the pairing code.";
  if (plain.length !== PAIRING_CODE_LENGTH) return `A pairing code has ${PAIRING_CODE_LENGTH} letters and digits.`;
  return null;
}

/** Setup's first step: the data folder and its preview, then the optional import and identity. */
export interface DataFolderForm {
  folder: string;
  /** The last preview, with the folder exactly as typed when previewed: the service answers with the path resolved. */
  preview: { folder: string; writable: boolean } | null;
  importFolder: string;
  importPreview: { folder: string } | null;
  name: string;
  email: string;
}

export type DataFolderField = "folder" | "import" | "name";

export function dataFolderProblems(form: DataFolderForm): Array<FieldProblem<DataFolderField>> {
  const problems: Array<FieldProblem<DataFolderField>> = [];
  const folder = form.folder.trim();
  if (!folder) problems.push({ field: "folder", message: "Enter a folder for your Brain." });
  else if (form.preview?.folder !== form.folder) problems.push({ field: "folder", message: "Preview this folder to see what Attache will create in it." });
  else if (!form.preview.writable) problems.push({ field: "folder", message: "Attache cannot write here. Choose another folder." });
  const importFolder = form.importFolder.trim();
  if (importFolder && form.importPreview?.folder !== form.importFolder) problems.push({ field: "import", message: "Preview the import, or clear this field." });
  const name = form.name.trim();
  const email = form.email.trim();
  // The service keeps an identity only with a name, and any email beside it; an email alone would be lost.
  if (email && !name) problems.push({ field: "name", message: "Add your name, or clear the email." });
  return problems;
}

/** Joining another Machine's Brain: the repository it replicates to, and the empty folder the Brain is cloned into. */
export function joinProblems(form: { repository: string; folder: string }): Array<FieldProblem<"repository" | "folder">> {
  const problems: Array<FieldProblem<"repository" | "folder">> = [];
  if (!form.repository.trim()) problems.push({ field: "repository", message: "Enter the repository your other Machine replicates to." });
  if (!form.folder.trim()) problems.push({ field: "folder", message: "Enter an empty folder for the Brain." });
  return problems;
}

/** The service's Join refusals the owner fixes in one field; any other refusal belongs to the form as a whole. */
const JOIN_ERROR_FIELDS: Record<string, "repository" | "folder"> = {
  invalid_remote: "repository",
  remote_empty: "repository",
  remote_refused: "repository",
  remote_unauthorized: "repository",
  remote_unreachable: "repository",
  remote_has_brain: "repository",
  invalid_path: "folder",
  not_a_folder: "folder",
  not_writable: "folder",
  not_empty: "folder",
  needs_data_folder: "folder",
  already_a_repository: "folder",
};

export function joinErrorField(code: string | undefined): "repository" | "folder" | null {
  return (code && JOIN_ERROR_FIELDS[code]) || null;
}
