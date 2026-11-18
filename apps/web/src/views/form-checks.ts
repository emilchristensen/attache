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
  /** The last preview, with the folder as it was typed when previewed: the service answers with the path resolved. */
  preview: { folder: string; writable: boolean } | null;
  importFolder: string;
  importPreview: { folder: string } | null;
  name: string;
  email: string;
}

export type DataFolderField = "folder" | "import" | "name" | "email";

/** Loose on purpose: something before and after one @, with a dot in the domain. The service checks nothing more. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function dataFolderProblems(form: DataFolderForm): Array<FieldProblem<DataFolderField>> {
  const problems: Array<FieldProblem<DataFolderField>> = [];
  const folder = form.folder.trim();
  if (!folder) problems.push({ field: "folder", message: "Enter a folder for your Brain." });
  else if (form.preview?.folder.trim() !== folder) problems.push({ field: "folder", message: "Preview this folder to see what Attache will create in it." });
  else if (!form.preview.writable) problems.push({ field: "folder", message: "Attache cannot write here. Choose another folder." });
  const importFolder = form.importFolder.trim();
  if (importFolder && form.importPreview?.folder.trim() !== importFolder) problems.push({ field: "import", message: "Preview the import, or clear this field." });
  const name = form.name.trim();
  const email = form.email.trim();
  if (email && !name) problems.push({ field: "name", message: "Add your name, or clear the email." });
  if (email && !EMAIL.test(email)) problems.push({ field: "email", message: "Enter an email address such as alex@example.com, or leave it empty." });
  return problems;
}

/** Joining another Machine's Brain: the repository it replicates to, and the empty folder the Brain is cloned into. */
export function joinProblems(form: { repository: string; folder: string }): Array<FieldProblem<"repository" | "folder">> {
  const problems: Array<FieldProblem<"repository" | "folder">> = [];
  if (!form.repository.trim()) problems.push({ field: "repository", message: "Enter the repository your other Machine replicates to." });
  if (!form.folder.trim()) problems.push({ field: "folder", message: "Enter an empty folder for the Brain." });
  return problems;
}
