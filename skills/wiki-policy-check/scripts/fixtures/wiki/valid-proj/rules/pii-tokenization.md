---
id: RULE-pii-tokenization
title: Tokenizar PII antes de logging/cache
project: valid-proj
type: security
status: active
kind: rule
tags: [pii, lgpd]
---

## Enunciado
Dados pessoais (CPF, endereço) são tokenizados antes de qualquer logging ou cache.

## Justificativa
Compliance LGPD; reduzir blast radius de incidentes.
