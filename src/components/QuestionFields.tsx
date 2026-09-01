// Renders a list of TEXT | SELECT | CHECKBOX questions with controlled
// answers. Extracted from the checkout "questions" step
// (src/app/events/[slug]/page.tsx) so the post-event survey response page
// can reuse the exact same field rendering — RegistrationQuestion and
// SurveyQuestion share this identical shape by design (see the
// SurveyQuestion schema comment).

export interface QuestionFieldsQuestion {
  id: string;
  label: string;
  type: "TEXT" | "SELECT" | "CHECKBOX";
  options: string | null;
  required: boolean;
}

export default function QuestionFields({
  questions,
  answers,
  onChange,
}: {
  questions: QuestionFieldsQuestion[];
  answers: Record<string, string>;
  onChange: (questionId: string, value: string) => void;
}) {
  return (
    <div className="space-y-4">
      {questions.map((q) => (
        <div key={q.id}>
          <label className="label" htmlFor={`q-${q.id}`}>
            {q.label}
            {q.required && <span className="text-danger"> *</span>}
          </label>
          {q.type === "TEXT" && (
            <input
              id={`q-${q.id}`}
              className="input"
              value={answers[q.id] ?? ""}
              onChange={(e) => onChange(q.id, e.target.value)}
            />
          )}
          {q.type === "SELECT" && (
            <select
              id={`q-${q.id}`}
              className="input"
              value={answers[q.id] ?? ""}
              onChange={(e) => onChange(q.id, e.target.value)}
            >
              <option value="">Select…</option>
              {(q.options ?? "")
                .split(",")
                .map((opt) => opt.trim())
                .filter(Boolean)
                .map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
            </select>
          )}
          {q.type === "CHECKBOX" && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={(answers[q.id] ?? "") === "yes"}
                onChange={(e) => onChange(q.id, e.target.checked ? "yes" : "")}
              />
              Yes
            </label>
          )}
        </div>
      ))}
    </div>
  );
}
