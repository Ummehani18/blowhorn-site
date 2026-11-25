{{- $support := site.Data.support -}}
# {{ .Params.heading | default .Title }}

> {{ .Params.lead }}

## Send us a message

Use the HTML form to send feedback anonymously, or choose a response and leave your email. Name is optional. You can also email **{{ $support.email }}**. Include
the exit code and the first words of the error; leave out credentials,
session files and anything from your Google Chrome profile directories. A
security problem goes to security@blowhorn.ai, never a public issue.

The contact form stores your reason and response preference in the support queue.

## Let your AI help with the details

{{ site.Data.support_diagnostics.prompt }}

## Start with the docs
{{ range .Params.cards }}
- **[{{ .title }}]({{ .href }})** - {{ .text }}
{{- end }}
