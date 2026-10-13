"use client";

import { useState } from "react";
import { Button } from "../../../src/ui/Button.tsx";
import { type DiscState, DividedDisc } from "../../../src/ui/DividedDisc.tsx";
import styles from "./catalogue.module.css";

// The disc's motion in sequence, driven by hand: buy, undo, and the two results.
export function DiscDemo() {
	const [state, setState] = useState<DiscState>("whole");
	return (
		<div className={styles.demo}>
			<DividedDisc state={state} size={128} />
			<div className={styles.row}>
				<Button variant="secondary" onClick={() => setState("split")}>
					Buy
				</Button>
				<Button variant="secondary" onClick={() => setState("whole")}>
					Undo
				</Button>
				<Button variant="secondary" onClick={() => setState("resolved-yes")}>
					They beat
				</Button>
				<Button variant="secondary" onClick={() => setState("resolved-no")}>
					They didn't
				</Button>
			</div>
		</div>
	);
}
