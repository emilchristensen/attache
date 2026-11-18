import { describe, expect, it } from "vitest";
import { dataFolderProblems, joinErrorField, joinProblems, pairingCodeProblem, type DataFolderForm } from "../src/views/form-checks.ts";

describe("pairingCodeProblem", () => {
  it.each([
    ["", "Enter the pairing code."],
    ["   ", "Enter the pairing code."],
    ["ABC", "A pairing code has 8 letters and digits."],
    ["ABCD23456", "A pairing code has 8 letters and digits."],
  ])("refuses %j before asking the service", (code, message) => {
    expect(pairingCodeProblem(code)).toBe(message);
  });

  it.each(["ABCD2345", "abcd2345", "ABCD-2345", " ABCD 2345 "])("accepts %j, written as the installer and the command line show it", (code) => {
    expect(pairingCodeProblem(code)).toBeNull();
  });
});

const READY: DataFolderForm = {
  folder: "/home/alex/Documents/Attache",
  preview: { folder: "/home/alex/Documents/Attache", writable: true },
  importFolder: "",
  importPreview: null,
  name: "",
  email: "",
};

describe("dataFolderProblems", () => {
  it("has nothing to say about a previewed, writable folder with the optional parts left empty", () => {
    expect(dataFolderProblems(READY)).toEqual([]);
  });

  it.each<[string, Partial<DataFolderForm>, Array<[string, string]>]>([
    ["an empty data folder", { folder: "  ", preview: null }, [["folder", "Enter a folder for your Brain."]]],
    ["a folder not previewed yet", { preview: null }, [["folder", "Preview this folder to see what Attache will create in it."]]],
    ["a preview of another folder", { folder: "/home/alex/Brain" }, [["folder", "Preview this folder to see what Attache will create in it."]]],
    ["a folder Attache cannot write to", { preview: { folder: READY.folder, writable: false } }, [["folder", "Attache cannot write here. Choose another folder."]]],
    ["a folder to import that was not previewed", { importFolder: "/home/alex/Notes" }, [["import", "Preview the import, or clear this field."]]],
    ["an import preview of another folder", { importFolder: "/home/alex/Notes", importPreview: { folder: "/home/alex/Vault" } }, [["import", "Preview the import, or clear this field."]]],
    ["an email without a name", { email: "alex@example.com" }, [["name", "Add your name, or clear the email."]]],
    [
      "several problems, in the order the fields appear",
      { folder: "", preview: null, importFolder: "/home/alex/Notes", email: "alex@example.com" },
      [
        ["folder", "Enter a folder for your Brain."],
        ["import", "Preview the import, or clear this field."],
        ["name", "Add your name, or clear the email."],
      ],
    ],
  ])("names %s", (_, change, expected) => {
    expect(dataFolderProblems({ ...READY, ...change }).map((p) => [p.field, p.message])).toEqual(expected);
  });

  it.each<[string, Partial<DataFolderForm>]>([
    ["a previewed import", { importFolder: "/home/alex/Notes", importPreview: { folder: "/home/alex/Notes" } }],
    ["a name without an email", { name: "Alex" }],
    ["a name and an email", { name: "Alex", email: "alex@example.com" }],
    // The service keeps any email it is given, so Setup does not judge its form.
    ["an email on a local host", { name: "Alex", email: "alex@localhost" }],
    ["paths with spaces around them", { folder: ` ${READY.folder} `, importFolder: " /home/alex/Notes ", importPreview: { folder: "/home/alex/Notes" } }],
  ])("accepts %s", (_, change) => {
    expect(dataFolderProblems({ ...READY, ...change })).toEqual([]);
  });
});

describe("joinProblems", () => {
  it.each<[string, { repository: string; folder: string }, Array<[string, string]>]>([
    ["a repository and a folder", { repository: "owner/attache-brain", folder: "/home/alex/Brain" }, []],
    ["no repository", { repository: " ", folder: "/home/alex/Brain" }, [["repository", "Enter the repository your other Machine replicates to."]]],
    ["no folder", { repository: "owner/attache-brain", folder: "" }, [["folder", "Enter an empty folder for the Brain."]]],
    [
      "neither, repository first as on screen",
      { repository: "", folder: "" },
      [
        ["repository", "Enter the repository your other Machine replicates to."],
        ["folder", "Enter an empty folder for the Brain."],
      ],
    ],
  ])("with %s", (_, form, expected) => {
    expect(joinProblems(form).map((p) => [p.field, p.message])).toEqual(expected);
  });
});

describe("joinErrorField", () => {
  it.each(["invalid_remote", "remote_empty", "remote_refused", "remote_unauthorized", "remote_unreachable", "remote_has_brain"])("puts the service's %s on the repository", (code) => {
    expect(joinErrorField(code)).toBe("repository");
  });

  it.each(["invalid_path", "not_writable", "not_empty", "needs_data_folder", "already_a_repository"])("puts the service's %s on the folder", (code) => {
    expect(joinErrorField(code)).toBe("folder");
  });

  it.each(["git_missing", "busy", "already_set_up", "replication_failed", "offline", undefined])("keeps %s, which no field can fix, for the form", (code) => {
    expect(joinErrorField(code)).toBeNull();
  });
});
