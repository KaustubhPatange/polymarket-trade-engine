type Props = {
  value: string;
  options: string[];
  onChange: (value: string) => void;
};

export function StrategyDropdown({ value, options, onChange }: Props) {
  return (
    <select
      className="dropdown"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="All">Strategy: All</option>
      {options.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}
