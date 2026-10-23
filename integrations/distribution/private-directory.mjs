import { chmod as e, lstat as t, mkdir as n, readdir as r, realpath as i } from "node:fs/promises";
import { execFile as a } from "node:child_process";
import { promisify as o } from "node:util";
import s from "node:path";
import "node:crypto";
var c = class extends Error {
	constructor(e) {
		super(e), this.name = "QuickConnectError";
	}
}, l = class extends Error {
	code;
	constructor(e, t) {
		super(t), this.code = e, this.name = "ConnectorSetupError";
	}
}, u = o(a);
function d(e, t = process.env) {
	let n = Object.entries(t).find(([e]) => e.toLowerCase() === "systemroot")?.[1] ?? Object.entries(t).find(([e]) => e.toLowerCase() === "windir")?.[1];
	if (!n || !/^[A-Za-z]:[\\/]/.test(n) || /[\x00-\x1f<>"|?*]/.test(n)) throw new l("WINDOWS_HELPER_UNAVAILABLE", "Windows system directory could not be located. Run the connector from a normal Windows terminal with SystemRoot set; preserve any saved connection for retry.");
	return e === "powershell.exe" ? s.win32.join(n, "System32", "WindowsPowerShell", "v1.0", e) : s.win32.join(n, "System32", e);
}
async function f() {
	try {
		let { stdout: e } = await u(d("whoami.exe"), [
			"/user",
			"/fo",
			"csv",
			"/nh"
		], {
			windowsHide: !0,
			timeout: 1e4
		}), t = e.match(/\bS-1-[0-9]+(?:-[0-9]+)+\b/)?.[0];
		if (!t) throw Error();
		return t;
	} catch {
		throw new l("WINDOWS_ACCOUNT_UNAVAILABLE", "Could not identify the current Windows account for private credential storage or user startup. Run the connector from your Windows account; preserve any saved connection for retry.");
	}
}
var p = o(a);
async function m(a) {
	let o = s.resolve(a);
	await n(o, {
		recursive: !0,
		mode: 448
	});
	let l = s.resolve(await i(o));
	if ((await t(o)).isSymbolicLink() || (process.platform === "win32" ? l.toLowerCase() !== o.toLowerCase() : l !== o)) throw new c("Choose a private state directory without symbolic links");
	if (process.platform === "win32") {
		let e = await f(), t = [
			"$ErrorActionPreference='Stop'",
			`$p='${o.replaceAll("'", "''")}'`,
			`$s=New-Object System.Security.Principal.SecurityIdentifier('${e}')`,
			"$d=[System.IO.DirectoryInfo]::new($p)",
			"if ($d.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner).GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $s.Value) { throw 'Credential directory owner mismatch' }",
			"$a=New-Object System.Security.AccessControl.DirectorySecurity",
			"$a.SetAccessRuleProtection($true,$false)",
			"$r=New-Object System.Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow')",
			"$a.AddAccessRule($r)",
			"$d.SetAccessControl($a)",
			"$v=$d.GetAccessControl()",
			"$g=@($v.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))",
			"if ($v.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $s.Value -or !$v.AreAccessRulesProtected -or $g.Count -ne 1 -or $g[0].IdentityReference.Value -ne $s.Value -or $g[0].IsInherited -or $g[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $g[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or [int]$g[0].InheritanceFlags -ne 3 -or [int]$g[0].PropagationFlags -ne 0) { throw 'Credential directory ACL verification failed' }"
		].join("; ");
		try {
			await p(d("powershell.exe"), [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				t
			], {
				windowsHide: !0,
				timeout: 2e4
			}), (await r(o)).length && await p(d("icacls.exe"), [
				s.join(o, "*"),
				"/reset",
				"/T",
				"/L",
				"/Q"
			], {
				windowsHide: !0,
				timeout: 2e4
			});
		} catch {
			throw new c("Windows could not restrict credential storage to your account. Choose an owned private state directory and retry; this check did not redeem an enrollment token");
		}
	} else await e(o, 448);
	return o;
}
export { m as privateDirectory };
