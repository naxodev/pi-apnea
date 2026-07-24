import * as fs from "node:fs";
import {
	asVerdict,
	isCompleteArtifact,
	parseFrontMatter,
} from "../domain/frontmatter.ts";
import type { FrontMatter } from "./types.ts";

export { asVerdict, isCompleteArtifact, parseFrontMatter };

export function readArtifact(filePath: string): FrontMatter | null {
	if (!fs.existsSync(filePath)) return null;
	const text = fs.readFileSync(filePath, "utf8");
	return parseFrontMatter(text);
}
