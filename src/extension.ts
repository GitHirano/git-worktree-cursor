import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import { promisify } from "util";

const exec = promisify(cp.exec);
const execFile = promisify(cp.execFile);

// デフォルトのローカルファイルパターン
const DEFAULT_LOCAL_FILE_PATTERNS = [
  "**/.env*",
  "**/*.local.*",
  "**/config.local.*",
  ".vscode/settings.json",
];

// 設定から追加のパターンを取得
function getLocalFilePatterns(): string[] {
  const configPatterns = vscode.workspace
    .getConfiguration("git-worktree-cursor")
    .get<string[]>("localFilePatterns", []);
  return [...DEFAULT_LOCAL_FILE_PATTERNS, ...configPatterns];
}

interface Worktree {
  path: string;
  branch: string;
  isMain: boolean;
}

class WorktreeItem extends vscode.TreeItem {
  constructor(
    public readonly worktree: Worktree,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(worktree.branch, collapsibleState);
    this.tooltip = this.worktree.path;
    this.description = this.worktree.isMain ? "(main)" : "";
    this.contextValue = this.worktree.isMain ? "mainWorktree" : "worktree";
    this.iconPath = new vscode.ThemeIcon(this.worktree.isMain ? "git-branch" : "folder-opened");
  }
}

// ディレクトリを再帰的にコピーする関数
function copyDirectoryRecursive(source: string, target: string): void {
  // ターゲットディレクトリを作成
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }

  // ソースディレクトリの内容を読み取る
  const files = fs.readdirSync(source, { withFileTypes: true });

  for (const file of files) {
    const sourcePath = path.join(source, file.name);
    const targetPath = path.join(target, file.name);

    if (file.isDirectory()) {
      // ディレクトリの場合は再帰的にコピー
      copyDirectoryRecursive(sourcePath, targetPath);
    } else {
      // ファイルの場合はコピー
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

// ローカルファイルをコピーする関数
async function copyLocalFiles(sourcePath: string, targetPath: string): Promise<void> {
  try {
    for (const pattern of getLocalFilePatterns()) {
      const sourceEntries = await findMatchingEntries(sourcePath, pattern);

      for (const sourceEntry of sourceEntries) {
        const relativePath = path.relative(sourcePath, sourceEntry);
        const targetEntry = path.join(targetPath, relativePath);

        // エントリの情報を取得
        const stat = fs.statSync(sourceEntry);

        if (stat.isDirectory()) {
          // ディレクトリの場合は再帰的にコピー
          console.log(`Copying directory: ${relativePath}`);
          copyDirectoryRecursive(sourceEntry, targetEntry);
        } else {
          // ファイルの場合
          // ターゲットディレクトリが存在しない場合は作成
          const targetDir = path.dirname(targetEntry);
          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }

          // ファイルをコピー
          fs.copyFileSync(sourceEntry, targetEntry);
          console.log(`Copied file: ${relativePath}`);
        }
      }
    }
  } catch (error) {
    console.error("Error copying local files:", error);
    // エラーが発生してもworktree作成は続行
  }
}

async function findMatchingEntries(basePath: string, pattern: string): Promise<string[]> {
  const matchingEntries: string[] = [];

  try {
    // glob的なパターンマッチングを簡易実装
    if (pattern.includes("*")) {
      const entries = await getAllEntries(basePath, [], pattern);
      const regex = patternToRegex(pattern);

      for (const entry of entries) {
        const relativePath = path.relative(basePath, entry);
        // Windows環境でもUnix形式のパスセパレータに統一
        const normalizedPath = relativePath.replace(/\\/g, '/');
        
        // デバッグログ
        if (pattern.includes('.env') || pattern.includes('node_modules')) {
          console.log(`[findMatchingEntries] Testing pattern: ${pattern} against path: ${normalizedPath}`);
          console.log(`[findMatchingEntries] Regex test result: ${regex.test(normalizedPath)}`);
          console.log(`[findMatchingEntries] Entry type: ${fs.statSync(entry).isDirectory() ? 'directory' : 'file'}`);
        }
        
        if (regex.test(normalizedPath)) {
          matchingEntries.push(entry);
          console.log(`[findMatchingEntries] MATCHED: ${normalizedPath} with pattern: ${pattern}`);
        }
      }
    } else {
      // 直接パス指定の場合
      const fullPath = path.join(basePath, pattern);
      if (fs.existsSync(fullPath)) {
        matchingEntries.push(fullPath);
      }
    }
  } catch (error) {
    console.error(`Error finding entries for pattern ${pattern}:`, error);
  }

  return matchingEntries;
}

async function getAllEntries(dir: string, entries: string[] = [], pattern?: string): Promise<string[]> {
  try {
    const dirents = fs.readdirSync(dir, { withFileTypes: true });

    for (const dirent of dirents) {
      const fullPath = path.join(dir, dirent.name);

      if (dirent.isDirectory()) {
        // パフォーマンスのため、大きなディレクトリは除外
        const excludeDirs = ["node_modules", ".next", "dist", "build", "out"];
        
        // パターンが明示的に除外ディレクトリを指定している場合は、除外しない
        const shouldExclude = !pattern || !excludeDirs.some(excludeDir => {
          // パターンが除外ディレクトリを含んでいるかチェック
          const normalizedPattern = pattern.replace(/\\/g, '/');
          return normalizedPattern.includes(excludeDir);
        });
        
        // .gitは除外しない（.git内のファイルも検索対象にする）
        if (shouldExclude && !excludeDirs.includes(dirent.name) && !dirent.name.startsWith(".git")) {
          // ディレクトリ自体もエントリとして追加
          entries.push(fullPath);
          // 再帰的に中身も取得
          await getAllEntries(fullPath, entries, pattern);
        } else if (!shouldExclude) {
          // パターンが除外ディレクトリを含む場合は、除外せずに追加
          entries.push(fullPath);
          await getAllEntries(fullPath, entries, pattern);
        }
      } else {
        entries.push(fullPath);
      }
    }
  } catch (error) {
    // ディレクトリアクセスエラーは無視
  }

  return entries;
}

function patternToRegex(pattern: string): RegExp {
  // Windows環境でもUnix形式のパスセパレータに統一
  pattern = pattern.replace(/\\/g, '/');
  
  // デバッグログ
  console.log(`[patternToRegex] Original pattern: ${pattern}`);
  
  // 先頭に ** がある場合の特別処理
  if (pattern.startsWith('**/')) {
    // **/.env -> (.env|.+/.env) のようなパターンを生成
    const remainingPattern = pattern.substring(3); // **/ を除去
    const escapedPattern = remainingPattern
      .replace(/\./g, "\\.")  // . をエスケープ
      .replace(/\*\*/g, "{{GLOBSTAR}}")  // ** を一時的にマーク
      .replace(/\*/g, "[^/]*")  // * は / 以外の任意の文字
      .replace(/{{GLOBSTAR}}/g, ".*")  // ** は任意の文字（/ を含む）
      .replace(/\?/g, "[^/]");  // ? は / 以外の単一文字
    
    // ルートレベルまたは任意のサブディレクトリにマッチ
    const regexPattern = `(.*\\/)?${escapedPattern}`;
    console.log(`[patternToRegex] Generated regex: ^${regexPattern}$`);
    return new RegExp(`^${regexPattern}$`);
  }
  
  // 通常のパターン処理
  let regexPattern = pattern
    .replace(/\./g, "\\.")           // . をエスケープ
    .replace(/\*\*/g, "{{GLOBSTAR}}")  // ** を一時的にマーク
    .replace(/\*/g, "[^/]*")          // * は / 以外の任意の文字
    .replace(/{{GLOBSTAR}}/g, ".*")  // ** は任意の文字（/ を含む）
    .replace(/\?/g, "[^/]");          // ? は / 以外の単一文字
  
  console.log(`[patternToRegex] Generated regex: ^${regexPattern}$`);
  
  return new RegExp(`^${regexPattern}$`);
}

class WorktreeProvider implements vscode.TreeDataProvider<WorktreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<WorktreeItem | undefined | null | void> =
    new vscode.EventEmitter<WorktreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<WorktreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  constructor(private workspaceRoot: string | undefined) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: WorktreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: WorktreeItem): Thenable<WorktreeItem[]> {
    if (!this.workspaceRoot) {
      vscode.window.showInformationMessage("No workspace folder open");
      return Promise.resolve([]);
    }

    if (element) {
      return Promise.resolve([]);
    } else {
      return this.getWorktrees();
    }
  }

  private async getWorktrees(): Promise<WorktreeItem[]> {
    try {
      const { stdout: worktreeList } = await exec("git worktree list", { cwd: this.workspaceRoot });
      const worktrees = worktreeList
        .trim()
        .split("\n")
        .map((line) => {
          const parts = line.trim().split(/\s+/);
          const worktreePath = parts[0];
          const branch = parts[2] ? parts[2].replace(/[\[\]]/g, "") : "";
          return {
            path: worktreePath,
            branch: branch || "main",
            isMain: worktreePath === this.workspaceRoot,
          };
        });

      return worktrees.map((wt) => new WorktreeItem(wt, vscode.TreeItemCollapsibleState.None));
    } catch (error) {
      console.error("Error getting worktrees:", error);
      return [];
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log("Git Worktree + cursor Editor is now active!");

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceRoot = workspaceFolder?.uri.fsPath;

  // Create tree data provider
  const worktreeProvider = new WorktreeProvider(workspaceRoot);
  vscode.window.registerTreeDataProvider("gitWorktreeExplorer", worktreeProvider);

  // Register refresh command
  let refreshDisposable = vscode.commands.registerCommand(
    "git-worktree-cursor.refreshWorktrees",
    () => {
      worktreeProvider.refresh();
    }
  );

  let disposable = vscode.commands.registerCommand("git-worktree-cursor.addWorktree", async () => {
    try {
      // Get the workspace folder
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage("No workspace folder open");
        return;
      }

      // Get the repository name
      const repoPath = workspaceFolder.uri.fsPath;
      const repoName = path.basename(repoPath);

      // Prompt for branch name
      const branchName = await vscode.window.showInputBox({
        prompt: "Enter branch name",
        placeHolder: "feature/my-new-feature",
        validateInput: (value) => {
          if (!value || value.trim() === "") {
            return "Branch name cannot be empty";
          }
          // Check for path traversal attempts
          if (value.includes("..") || value.includes("./") || value.includes("\\")) {
            return "Branch name cannot contain path traversal characters (.. ./ \\)";
          }
          // Check for absolute paths
          if (path.isAbsolute(value)) {
            return "Branch name cannot be an absolute path";
          }
          // Improved validation for branch names (allow dots but not consecutive ones)
          if (!/^[a-zA-Z0-9\/_.-]+$/.test(value)) {
            return "Branch name contains invalid characters. Use only letters, numbers, /, _, -, and .";
          }
          // Prevent consecutive dots
          if (/\.\./.test(value)) {
            return "Branch name cannot contain consecutive dots (..)";
          }
          // Prevent starting or ending with special characters
          if (/^[.\-_/]|[.\-_/]$/.test(value)) {
            return "Branch name cannot start or end with ., -, _, or /";
          }
          return null;
        },
      });

      if (!branchName) {
        return; // User cancelled
      }

      // Create default parent directory structure
      // Get the parent directory of the current repository
      const repoParentDir = path.dirname(repoPath);

      // Create the worktree parent directory name: <repo-name>-worktree
      const worktreeParentDirName = `${repoName}-worktree`;
      const worktreeParentPath = path.join(repoParentDir, worktreeParentDirName);

      // Create the worktree path: <repo-name>-worktree/<branch-name>
      const worktreePath = path.normalize(path.join(worktreeParentPath, branchName));
      
      // Security check: ensure the worktree path is within the expected parent directory
      if (!worktreePath.startsWith(worktreeParentPath + path.sep) && worktreePath !== worktreeParentPath) {
        vscode.window.showErrorMessage("Invalid worktree path detected for security reasons");
        return;
      }

      // Ensure the parent directory exists
      if (!fs.existsSync(worktreeParentPath)) {
        fs.mkdirSync(worktreeParentPath, { recursive: true });
      }

      // Show progress
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Creating Git Worktree",
          cancellable: false,
        },
        async (progress) => {
          progress.report({ increment: 0, message: "Creating worktree..." });

          try {
            // Execute git worktree add command
            await execFile("git", ["worktree", "add", worktreePath, "-b", branchName], { cwd: repoPath });

            progress.report({ increment: 30, message: "Copying local files..." });

            // ローカルファイルをコピー
            await copyLocalFiles(repoPath, worktreePath);

            progress.report({ increment: 70, message: "Opening in Cursor..." });

            // Open in Cursor
            try {
              await execFile("cursor", [worktreePath]);
            } catch (cursorError) {
              // If the cursor cannot be found, a warning is displayed but processing continues.
              console.warn("Cursor command failed:", cursorError);
              
              // 代替方法：現在のエディタ（Cursor）で新しいウィンドウを開く
              try {
                // true を指定することで新しいウィンドウで開く
                await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreePath), true);
              } catch (vscodeError) {
                console.warn("Failed to open new window:", vscodeError);
                vscode.window.showWarningMessage(
                  "Worktree created successfully, but failed to open in Cursor. Please open manually."
                );
              }
            }

            progress.report({ increment: 100, message: "Complete!" });

            vscode.window.showInformationMessage(
              `Successfully created worktree at '${worktreeParentDirName}/${branchName}' and opened in Cursor`
            );
            worktreeProvider.refresh();
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to create worktree: ${errorMessage}`);
            throw error;
          }
        }
      );
    } catch (error) {
      console.error("Error in git-worktree-cursor.addWorktree:", error);
    }
  });

  context.subscriptions.push(disposable);

  let deleteDisposable = vscode.commands.registerCommand(
    "git-worktree-cursor.deleteWorktree",
    async (item?: WorktreeItem) => {
      try {
        // Get the workspace folder
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
          vscode.window.showErrorMessage("No workspace folder open");
          return;
        }

        const repoPath = workspaceFolder.uri.fsPath;

        let selected:
          | Array<{
              label: string;
              description: string;
              worktree: { path: string; branch: string };
            }>
          | undefined;

        if (item && !item.worktree.isMain) {
          // Single item from context menu
          selected = [
            {
              label: item.worktree.branch,
              description: item.worktree.path,
              worktree: item.worktree,
            },
          ];
        } else {
          // Get list of worktrees
          const { stdout: worktreeList } = await exec("git worktree list", { cwd: repoPath });
          const worktrees = worktreeList
            .trim()
            .split("\n")
            .map((line) => {
              const parts = line.trim().split(/\s+/);
              const path = parts[0];
              const branch = parts[2] ? parts[2].replace(/[\[\]]/g, "") : "";
              return { path, branch, label: `${branch} (${path})` };
            })
            .filter((wt) => wt.path !== repoPath); // Exclude main worktree

          if (worktrees.length === 0) {
            vscode.window.showInformationMessage("No worktrees found to delete");
            return;
          }

          // Show quick pick with multi-select
          selected = await vscode.window.showQuickPick(
            worktrees.map((wt) => ({
              label: wt.label,
              description: wt.path,
              picked: false,
              worktree: wt,
            })),
            {
              canPickMany: true,
              placeHolder: "Select worktrees to delete",
              title: "Delete Git Worktrees",
            }
          );

          if (!selected || selected.length === 0) {
            return; // User cancelled
          }
        }

        // Confirm deletion
        const deleteMessage = `Are you sure you want to delete ${
          selected.length
        } worktree director${selected.length > 1 ? "ies" : "y"}?`;

        const confirm = await vscode.window.showWarningMessage(
          deleteMessage,
          "Directory and Branch",
          "Directory Only",
          "Cancel"
        );

        if (confirm === "Cancel" || confirm === undefined) {
          return;
        }

        const deletionOption =
          confirm === "Directory Only" ? "directory-only" : "directory-and-branch";

        // Delete selected worktrees
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Deleting Git Worktrees",
            cancellable: false,
          },
          async (progress) => {
            const total = selected!.length;
            let completed = 0;

            for (const item of selected!) {
              progress.report({
                increment: 100 / total,
                message: `Deleting ${item.worktree.branch}...`,
              });

              try {
                // Remove worktree
                await execFile("git", ["worktree", "remove", "--force", item.worktree.path], {
                  cwd: repoPath,
                });

                // If user chose to delete branch as well
                if (deletionOption === "directory-and-branch") {
                  try {
                    // Delete local branch
                    await execFile("git", ["branch", "-D", item.worktree.branch], {
                      cwd: repoPath,
                    });
                  } catch (branchError) {
                    // Branch might not exist or might be the current branch
                    console.warn(`Failed to delete branch ${item.worktree.branch}:`, branchError);
                  }
                }

                completed++;
              } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(
                  `Failed to delete worktree ${item.worktree.branch}: ${errorMessage}`
                );
              }
            }

            if (completed > 0) {
              const successMessage =
                deletionOption === "directory-and-branch"
                  ? `Successfully deleted ${completed} worktree director${
                      completed > 1 ? "ies" : "y"
                    } and local branch${completed > 1 ? "es" : ""}`
                  : `Successfully deleted ${completed} worktree director${
                      completed > 1 ? "ies" : "y"
                    }`;
              vscode.window.showInformationMessage(successMessage);
              worktreeProvider.refresh();
            }
          }
        );
      } catch (error) {
        console.error("Error in git-worktree-cursor.deleteWorktree:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to list worktrees: ${errorMessage}`);
      }
    }
  );

  context.subscriptions.push(refreshDisposable);
  context.subscriptions.push(deleteDisposable);
}

export function deactivate() {}
