{{/*
Expand the name of the chart.
*/}}
{{- define "firecrawl.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "firecrawl.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Chart name and version label.
*/}}
{{- define "firecrawl.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels.
*/}}
{{- define "firecrawl.labels" -}}
helm.sh/chart: {{ include "firecrawl.chart" . }}
{{ include "firecrawl.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector labels.
*/}}
{{- define "firecrawl.selectorLabels" -}}
app.kubernetes.io/name: {{ include "firecrawl.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Selenoid selector labels.
*/}}
{{- define "firecrawl.selenoid.selectorLabels" -}}
app.kubernetes.io/name: {{ include "firecrawl.name" . }}-selenoid
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: selenoid
{{- end -}}

{{/*
Resolve the selenoid size preset.
*/}}
{{- define "firecrawl.selenoid.size" -}}
{{- $preset := .Values.selenoid.sizePreset | default "small" -}}
{{- $resolved := index .Values.selenoid.resources $preset -}}
{{- $resolved -}}
{{- end -}}

{{/*
selenoid image reference.
*/}}
{{- define "firecrawl.selenoid.image" -}}
{{- printf "%s/%s:%s" .Values.selenoid.image.registry .Values.selenoid.image.repository .Values.selenoid.image.tag -}}
{{- end -}}
