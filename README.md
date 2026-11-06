# Workday Autofill

A userscript that fills Workday job applications (My Experience Only):
work experience, education, languages, skills, websites and LinkedIn.

## Install

1. Install a JavaScript browser extension like Violentmonkey.
2. Paste in `autofill.js`as a new script and save.

## Add your data

Open the script and replace the sample `DEFAULT_PROFILE` near the top with your own:

```js
work: [
  {
    title: 'Software Engineering Intern',
    company: 'Example Corp',
    location: 'Springfield, IL',
    current: false,
    from: { month: 6, year: 2025 },
    to: { month: 8, year: 2025 },
    description: 'One paragraph about what you did.',
  },
],
```

- `degree`, `fieldOfStudy`, `language` and `level` take a list of spellings. The first one that matches the company's dropdown is used.
- Add `skip: true` to an entry to leave it out.

## Use

1. Go to the **My Experience** step of a Workday application.
2. Click **Autofill My Experience** at the bottom right, then **Fill all**.
3. Check the log. Fix anything marked ⚠ by hand, review the page, then click **Save and Continue** yourself.

## Notes

- Works on `*.myworkdayjobs.com`, `*.myworkday.com` and `*.myworkdaysite.com`.
- Always review the page before you continue.
- It doesn't fill Certifications or upload a resume.
- Don't commit your personal data.
