// A password box with a show/hide eye (2026-09-22, John: "add the option to
// view the password"). Same props as <input>; `className` styles the input,
// the eye sits inside its right padding. The toggle is a button so Enter in
// the field still submits the form, and it is excluded from the tab order's
// "required" checks (type stays password|text on the input itself).
import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

export default function PasswordInput({ className = '', ...props }) {
  const [shown, setShown] = useState(false)
  return (
    <div className="relative">
      <input {...props} type={shown ? 'text' : 'password'} className={`${className} pr-10`} data-password-input />
      <button type="button" onClick={() => setShown((v) => !v)} tabIndex={-1} aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown} title={shown ? 'Hide' : 'Show'} data-password-toggle
        className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100">
        {shown ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  )
}
