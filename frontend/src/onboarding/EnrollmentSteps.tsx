export function EnrollmentSteps({ currentStep }: { currentStep: number }) {
  return <ol className="enrollment-step-list" aria-label="Enrollment steps">
    {['Agent type', 'Agent details', 'Setup'].map((label, index) => <li
      key={label} aria-current={currentStep === index ? 'step' : undefined}>
      <span>{index + 1}</span>{label}
    </li>)}
  </ol>;
}
