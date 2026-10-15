import { useEffect, useState, type ReactNode } from "react";
export function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<label className="cfg-field">
			<span>{label}</span>
			{children}
		</label>
	);
}
export function NumberField({
	label,
	value,
	onChange,
	min = 1,
	integer = true,
}: {
	label: string;
	value: number;
	onChange: (v: number) => void;
	min?: number;
	integer?: boolean;
}) {
	const [draft, setDraft] = useState(String(value));
	useEffect(() => setDraft(String(value)), [value]);
	return (
		<Field label={label}>
			<input
				type="number"
				min={min}
				step={integer ? 1 : "any"}
				value={draft}
				onChange={(e) => {
					const next = e.target.value;
					setDraft(next);
					if (next.trim() === "") return;
					const parsed = Number(next);
					if (
						Number.isFinite(parsed) &&
						parsed >= min &&
						(!integer || Number.isSafeInteger(parsed))
					)
						onChange(parsed);
				}}
				onBlur={() => setDraft(String(value))}
			/>
		</Field>
	);
}
export function Toggle({
	label,
	checked,
	onChange,
	disabled = false,
}: {
	label: string;
	checked: boolean;
	onChange: (v: boolean) => void;
	disabled?: boolean;
}) {
	return (
		<label className="cfg-toggle">
			<input
				type="checkbox"
				checked={checked}
				disabled={disabled}
				onChange={(e) => onChange(e.target.checked)}
			/>
			<span>{label}</span>
		</label>
	);
}
