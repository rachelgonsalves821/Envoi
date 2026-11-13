import { Check } from 'lucide-react';

export function EnrollmentSteps({ currentStep }: { currentStep: number }) {
  return <ol className="enroll-steps" aria-label="Enrollment steps">
    {['Agent', 'Details and access', 'Connect'].map((label, index) => <li
      key={label} aria-current={currentStep === index ? 'step' : undefined}
      className={currentStep === index ? 'current' : currentStep > index ? 'complete' : undefined}>
      <span className="enroll-step-number" aria-hidden="true">{index < currentStep ? <Check size={15} /> : index + 1}</span>
      <b>{label}</b>{index < currentStep && <span className="sr-only"> (complete)</span>}
    </li>)}
  </ol>;
}
