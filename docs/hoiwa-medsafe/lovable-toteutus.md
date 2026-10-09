# Hoiwa MedSafe × Lovable — kytkentä ja toteutusohje

Versio 0.1 · 2026-10-09 · Liittyy dokumenttiin [`tuotesuunnitelma.md`](./tuotesuunnitelma.md)

Tämä dokumentti on käytännön ohje MedSafen MVP:n rakentamiseen Lovablessa: mitä kytketään mihin,
mitä Lovablella kannattaa tehdä, mitä **ei**, ja valmiit promptit vaiheittain.

> **Mitä tässä sessiossa ei voitu tehdä:** Lovable-liitäntää ei ole käytettävissä Claude Coden
> työkaluna, eikä Lovable-tiliä voi yhdistää ohjelmallisesti. Tilin ja repon kytkentä tehdään
> Lovablen käyttöliittymässä kirjautuneena (§2). Tämä dokumentti tekee siitä yhden istunnon työn.

---

## 1. Arkkitehtuuripäätös ennen kytkentää

### 1.1 Oma repo, ei tätä repoa

| Vaihtoehto | Arvio |
| --- | --- |
| **MedSafe omaan repoon** (suositus) | Eri tuote, eri stack (React/Vite vs. tämän repon staattinen HTML + Netlify Functions), eri elinkaari ja eri asiakkaat. Lovable syncaa repon juureen ja hallitsee tiedostoja itse — se sotkisi tämän repon rakenteen. |
| MedSafe tähän repoon alikansioon | Lovablen git-sync toimii repon juuritasolla; alikansiomalli ei ole tuettu luotettavasti. **Ei suositella.** |

**Suositus:** uusi repo `hoiwa-medsafe`. Tämä repo (`aerwork-sales-agent`) jää myyntiagentiksi ja
CRM:ksi; MedSafe viittaa siihen vain integraatiorajapinnan kautta (tuotesuunnitelma, Liite A).

Huom: Lovablen oma dokumentaatio ja FAQ ovat ristiriidassa siitä, voiko **olemassa olevan** GitHub-repon
liittää Lovable-projektiin vai luoko Lovable aina uuden repon. Suositeltu polku (**Lovable luo repon**)
sivuuttaa tämän epävarmuuden kokonaan — ei tarvitse selvittää kumpi on voimassa.

### 1.2 Oma Supabase-projekti, ei Lovable Cloudia

Lovablen oletusbackend on Lovable Cloud (Lovablen hallinnoima Supabase-instanssi). MedSafessa se on
väärä valinta, ja tämä on **tuotepäätös, ei mielipide**:

| Syy | Peruste |
| --- | --- |
| **Datan sijainti** | Tuotesuunnitelman §11 kohta M1: Malesian ja Indonesian henkilötietosääntely on selvitettävä, ja datan sijainti voi olla sopimusehto. Lovable Cloudin alue lukittuu projektin luonnissa eikä ole jälkikäteen vaihdettavissa. |
| **Service role -avain** | Koemoottorin aikalaskenta, hyväksyntälogiikka ja sertifikaattien myöntäminen tarvitsevat palvelinpuolen oikeudet. Lovable Cloud ei anna service role -avainta eikä suoraa tietokantayhteyttä. |
| **Integraatio Hoiwa/AerWork** | Osaamistietojen välitys (Liite A) tarvitsee oman tietokannan ja webhookit. |
| **Varmuuskopiot ja säilytysajat** | §C.3 säilytysajat ja poistomenettely vaativat oman projektin hallinnan. |
| **Auditointi** | Asiakas voi vaatia nähtäväksi, missä ja miten data on. |

**Suositus:** luo Supabase-projekti itse, valitse alue vasta kun M1 on selvitetty (Singapore on
lähin yleisesti saatavilla oleva alue Kaakkois-Aasiassa — **vahvista** että se kelpaa kohdemaiden
sääntelyn kannalta, älä oleta), ja liitä **se** Lovableen.

Lovable Cloud ↔ oma Supabase -vaihto jälkikäteen ei ole yhden klikkauksen operaatio kumpaankaan
suuntaan, joten tämä päätös tehdään **ennen** ensimmäistä promptia.

---

## 2. Kytkentävaiheet

Tee järjestyksessä. Vaiheet 1–3 ennen yhtään toiminnallista promptia.

| # | Vaihe | Missä | Huomio |
| --- | --- | --- | --- |
| 1 | Luo Supabase-projekti `hoiwa-medsafe-dev` | supabase.com | Alue vasta M1-selvityksen jälkeen; aluksi dev-projekti, tuotanto erikseen |
| 2 | Luo Lovable-projekti ja liitä oma Supabase-projekti | Lovable: editorissa **More → Cloud → "Already have a Supabase project? Connect it here"**, tai dashboardin sivupalkista **Connectors → Supabase** | Valikkopolut ovat muuttuneet aiemmin; jos ei täsmää, etsi "Connect Supabase" |
| 3 | Kytke GitHub: anna Lovablen luoda repo `hoiwa-medsafe` | Lovable: **Project settings → Git** | Sync on branch-kohtainen: Lovable seuraa yhtä branchia kerrallaan. Muiden branchien commitit eivät näy Lovablessa ennen mergeä. |
| 4 | Aja prompti **P0** (skeema + RLS) | Lovable chat | Älä rakenna UI:ta ennen kuin skeema ja RLS ovat kunnossa |
| 5 | Tarkista RLS Supabasen SQL-editorissa | Supabase | §4 tarkistuslista — tee tämä itse, älä luota Lovablen raporttiin |
| 6 | Aja promptit P1→P6 järjestyksessä | Lovable chat | Yksi prompti = yksi toimiva osa; tarkista välissä |
| 7 | Kytke GitHub Actions -testit | repo | §5 hyväksymiskriteerien automatisointi |

Branch-huomio: tämän repon konventio on työskennellä `claude/*`-brancheilla. Lovable-repossa
kannattaa pitää Lovablen synkronoima branch `main` ja tehdä käsin kirjoitettu koodi (koemoottorin
palvelinlogiikka, testit) erillisillä brancheilla, jotka mergetään `main`iin — muuten Lovable ja
käsin tehdyt muutokset kilpailevat samasta tiedostosta.

---

## 3. Työnjako: mitä Lovablella, mitä ei

Lovable on nopea käyttöliittymissä, CRUD-näkymissä ja Supabase-kytkennöissä. Se ei ole oikea
työkalu arvioinnin eheydelle. Jako on tärkeä, koska MedSafen myyntiarvo on nimenomaan siinä, että
arviointiin voi luottaa.

| Osa | Lovable | Käsin / palvelinpuoli | Peruste |
| --- | --- | --- | --- |
| Oppijan etusivu, kurssinäkymä, osaamispassi | ✅ | | Puhdasta UI:ta |
| Osaamismatriisi ja raportit | ✅ | | Kyselyitä ja näkymiä |
| Käyttäjä- ja organisaatiohallinta | ✅ | | Vakio-CRUD + RLS |
| Sisältöstudio (luonnos→tarkastus→julkaisu) | ✅ | tilasiirtymien esto kannassa | UI Lovablella, säännöt kannassa |
| Arvioijan näyttölomake (UI) | ✅ | offline-synkronointi | Lomake on UI, mutta offline vaatii oman toteutuksen |
| **Kokeen aikalaskenta ja istunnon eheys** | ❌ | ✅ Edge function + kanta | Asiakas ei saa pidentää koeaikaa; aika lasketaan palvelimella (HK-5) |
| **Koekysymysten arvonta ja oikeat vastaukset** | ❌ | ✅ Edge function | Oikeat vastaukset eivät saa koskaan päätyä selaimeen (HK-4) |
| **Hyväksymisrajan soveltaminen** | ❌ | ✅ Edge function, luetaan `assessment_policy`sta | Ei kovakoodausta, ei frontend-laskentaa (HK-6) |
| **Kriittisen puutteen esto näytössä** | ❌ UI-esto riittämätön | ✅ kantatason constraint + edge function | Esto myös rajapintakutsussa (HK-7) |
| **Sertifikaatin myöntämisen ehdot** | ❌ | ✅ Edge function + RLS | Ei myöntöä puutteellisilla vaatimuksilla millään polulla (HK-9) |
| Sertifikaatin PDF | ❌ | ✅ edge function / palvelu | Vaatii fontit, QR:n ja deterministisen ulkoasun |
| Julkinen varmennussivu | osin | ✅ erillinen, minimaalinen endpoint | Vain vähimmäistiedot, ei sovelluksen autentikointia (HK-10) |

**Nyrkkisääntö promptatessa:** jos sääntö vaikuttaa siihen, kenelle myönnetään osaaminen, se
toteutetaan tietokannassa ja edge functionissa — ei Reactissa. Sano tämä Lovablelle joka kerta
(promptit alla tekevät sen).

---

## 4. Promptit

Promptit ovat englanniksi: Lovable toimii englanniksi luotettavimmin ja sovelluksen koodin ja
oletuskielen pitää olla englanti (tuotesuunnitelma: EN on ensimmäinen julkaisukieli).

Aja yksi kerrallaan. Tarkista tulos ennen seuraavaa. Jos Lovable tekee jotain muuta kuin pyydettiin,
korjaa ennen jatkamista — virheet kumuloituvat.

### P0 — Skeema ja käyttöoikeudet (aja ensin, ei UI:ta)

```text
We are building MedSafe, a B2B healthcare competence-assurance platform. Multi-tenant:
one tenant = one healthcare organisation. Do not build any UI yet. In this step, create only
the database schema and row level security in the connected Supabase project.

Core rule: competence is the primary entity, not courses. A course is a means; a granted
competence is the outcome.

Create these tables, every one with organization_id and RLS enabled:

Organisation and people
- organizations (name, country, type, default_locale)
- sites (organization_id, name, timezone)
- teams (site_id, name)
- app_users (auth user id, organization_id, full_name, email, locale, status, external_hr_id)
- role_assignments (user_id, role, scope_type: org|site|team, scope_id, valid_from, valid_to)
  roles: learner, trainer, assessor, supervisor, org_admin, content_author, clinical_reviewer, platform_admin
- assessor_qualifications (user_id, competency_version_id, verified_by, valid_from, valid_to)
- job_roles (organization_id, name)

Competence
- competencies (code, name, description, status)
- competency_versions (competency_id, version, learning_outcome, acceptance_criteria,
  requires_practical boolean, assessor_requirement, validity_months, renewal_rule,
  publish_status, approved_by, approved_at)
- competency_prerequisites (competency_version_id, required_competency_id)
- competency_requirements (job_role_id, competency_version_id, mandatory boolean)
- assessment_policies (organization_id, country, competency_version_id, theory_pass_mark,
  calculation_pass_mark, max_attempts, retry_wait_hours, allowed_aids jsonb,
  time_limit_minutes, timer_behaviour_on_disconnect: continue|pause, validity_months,
  renewal_rule, critical_criterion_rule, approved_by, approved_at, effective_from)

Content
- programs, courses, modules, lessons, content_assets, content_versions
  (content_versions must have: owner_user_id, sources text, reviewed_at, reviewed_by,
   next_review_at, publish_status, clinically_critical boolean)
- content_reviews (content_version_id, reviewer_id, decision, comments, created_at)
- translations (content_version_id, locale, status, translator_id, reviewer_id)

Learning
- intake_assessments, prior_learning_claims (with decision, decided_by, rationale)
- learning_paths, learning_path_items
- enrollments (user_id, course_id, course_content_version_id, status)
- lesson_progress, exercises, exercise_attempts
- supervised_practice_logs (user_id, competency_version_id, skill, performed_on,
  supervisor_id, feedback, confirmed_at)

Exams
- question_banks (competency_version_id, usage: practice|exam)  <-- practice and exam banks
  must be separate rows; a question belongs to exactly one bank
- questions, question_versions (content, options, correct_answer, feedback, unit, tolerance,
  reviewed_by, approved_at)
- exam_definitions (competency_version_id, type: theory|calculation, blueprint jsonb,
  question_count, time_limit_minutes)
- exam_attempts (user_id, exam_definition_id, assessment_policy_id, started_at, submitted_at,
  server_deadline_at, status, score, passed)
- exam_answers, exam_topic_results, exam_event_logs, exam_appeals

Practical assessment
- practical_forms, form_criteria (text, ordinal, is_critical boolean, scale)
- practical_assessments (user_id, practical_form_version_id, assessor_id,
  assessor_qualification_id, performed_at, location, status: draft|locked, decision, rationale)
- criterion_results (practical_assessment_id, form_criterion_id, result, observation)
- practical_corrections (original_assessment_id, reason, created_by, created_at)

Awards and certificates
- competency_awards (user_id, competency_version_id, assessment_policy_id, status,
  granted_at, valid_from, valid_to, approved_by, source_exam_attempt_ids,
  source_practical_assessment_id)
  status: not_started | in_progress | awaiting_assessment | valid | expired | revoked
  (do NOT store "expiring soon" — it is derived from valid_to)
- certificates (competency_award_id, type: attendance|completion|verified_competence,
  issuer, approved_by, issued_at, valid_to, content_version_ref, policy_version_ref,
  scope_and_limitations text, public_token)
- certificate_revocations (certificate_id, reason, created_by, created_at)
- employer_authorizations (user_id, task, granted_by_org, valid_from, valid_to,
  required_award_ids)  <-- separate from certificates, never merged into them
- renewal_schedules, notifications

Governance
- audit_logs (actor_id, action, target_type, target_id, old_value jsonb, new_value jsonb,
  created_at, organization_id)
- access_logs (who read assessment or personal data, what, when, reason)
- consents, retention_policies

Hard constraints to enforce in the database, not in the UI:
1. RLS on every table. A user may only read rows of their own organization_id.
   A learner may read only their own learning, exam and assessment rows.
   A supervisor may read status and result rows of their scope, but NOT exam_answers.
2. A question's bank usage must be exam or practice; a theory exam may only draw from an
   exam bank. Add a constraint or trigger preventing a practice question from being used in
   an exam attempt.
3. practical_assessments: when any linked criterion_result for a criterion with
   is_critical = true has result 'not_met', decision 'approved' must be impossible.
   Enforce with a trigger that raises an exception.
4. practical_assessments with status 'locked' are immutable; changes only via
   practical_corrections.
5. competency_awards with status 'valid' may only be inserted when the required sources exist
   (theory exam passed, calculation exam passed if required, practical assessment approved if
   requires_practical, supervised practice count met). Enforce with a trigger.
6. certificates may only be inserted for a competency_award with status 'valid'.
7. No pass mark, validity period, attempt limit or allowed-aid value anywhere in table defaults
   or application code. These come from assessment_policies only.
8. public_token must be at least 128 bits of entropy.
9. audit_logs rows are insert-only (no update, no delete) for all roles.

Write it as SQL migrations. Then show me the RLS policies you created, table by table, so I can
review them. Do not create any pages or components yet.
```

**Tarkistus P0:n jälkeen** (tee itse Supabasen SQL-editorissa, älä luota chatin yhteenvetoon):

```sql
-- 1. Onko RLS päällä kaikilla tauluilla?
select tablename from pg_tables
where schemaname = 'public'
  and tablename not in (select tablename from pg_tables t
    join pg_class c on c.relname = t.tablename where c.relrowsecurity)
order by 1;
-- odotettu tulos: tyhjä

-- 2. Onko jokaisella taululla organization_id?
select table_name from information_schema.tables t
where table_schema = 'public' and table_type = 'BASE TABLE'
  and not exists (select 1 from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = t.table_name
      and c.column_name = 'organization_id')
order by 1;
-- odotettu: vain selvät poikkeukset (esim. organizations itse) — käy läpi rivi riviltä

-- 3. Onko hyväksymisrajoja vuotanut defaultteihin?
select table_name, column_name, column_default from information_schema.columns
where table_schema = 'public'
  and (column_name like '%pass_mark%' or column_name like '%validity%'
       or column_name like '%max_attempt%')
  and column_default is not null;
-- odotettu tulos: tyhjä (HK-6)
```

### P1 — Oppijan etusivu

```text
Now build the learner home page. It must answer four questions at a glance:
what must I complete, what is my next step, what have I achieved, what needs renewal.

Layout, mobile first (360px must work with no horizontal scroll):
1. "Next step" card: exactly ONE primary action (the first incomplete learning_path_item),
   with estimated duration, attempt number out of max attempts from assessment_policies,
   and a single button.
2. Path progress: the stages of the learner's current program as a horizontal stepper
   (theory, exercises, theory exam, calculation exam, practical assessment, certificate)
   with completed / current / locked states.
3. "Waiting for me": supervised practice log count (x of y), practical assessment not yet
   scheduled, and similar pending items.
4. "My valid competences": each competency_award with status valid, showing valid_to.
   Show a warning style when valid_to is within 90 days, computed from valid_to — never read
   a stored "expiring" field.
5. Bottom actions: My competence passport, Study, Practice.

Rules:
- Read everything through RLS as the signed-in learner. Never query another user's rows.
- Show the content version and review date on study material (trust signal for clinical staff).
- The page must render correctly when the learner has no path yet (show "complete your
  competence intake first" with a link).
- Use the organisation's locale; all strings must go through an i18n layer with English as
  the default locale, prepared for bahasa Melayu and bahasa Indonesia.
- Timestamps are stored in UTC and displayed in the user's site timezone.
```

### P2 — Osaamiskartoitus ja oppimispolku

```text
Build the competence intake flow and the personal learning path generation.

Intake (learner): a short self-assessment per competency requirement of the learner's job_role,
plus an optional prior learning claim with document upload.

Prior learning claim rules:
- The claim cannot be submitted without at least one attached document.
- Only a user with an org_admin role assignment in scope may approve or reject it, and a
  rationale is mandatory. Enforce approval authority in RLS, not only in the UI.
- An approved claim marks the corresponding path item as satisfied and records the decision,
  decider and rationale as the source of that satisfaction.

Path generation (server side, Supabase function):
- Input: the learner's job_role competency_requirements.
- Output: learning_path_items only for requirements the learner does not currently hold as a
  valid competency_award, ordered by prerequisites.
- Each item must record WHY it exists (which requirement produced it) and be visible in the UI
  as "required by: <job role> / <requirement>".
- Re-running generation must be idempotent: it updates the path, it does not duplicate items.

Build the learner-facing intake UI and an org_admin review queue for prior learning claims.
```

### P3 — Koemoottori (kriittisin vaihe)

```text
Build the exam engine. Security and integrity matter more than looks here. All timing,
question selection and scoring must happen in Supabase edge functions with the service role.
The browser must never receive correct answers or be able to extend the exam time.

Edge function 1: start_exam(exam_definition_id)
- Rejects if an active attempt already exists for this user and definition (one active attempt).
- Reads the applicable assessment_policies row and stores assessment_policy_id on the attempt.
- Rejects if the learner has used up max_attempts, or if retry_wait_hours has not passed.
- Selects questions from the EXAM question bank only, following the blueprint's topic and
  difficulty distribution, randomised per attempt. Two consecutive attempts by the same
  learner must not get an identical question set.
- Computes server_deadline_at = now() + time_limit_minutes from the policy.
- Returns questions WITHOUT correct answers.

Edge function 2: submit_answer(attempt_id, question_version_id, answer)
- Rejects if now() > server_deadline_at.
- Stores the answer and an exam_event_log row.
- Returns no correctness information.

Edge function 3: submit_exam(attempt_id)
- Scores server side, writes exam_answers, exam_topic_results, total score.
- Determines pass/fail using the pass mark from the attempt's assessment_policy_id.
  There must be no pass mark constant anywhere in the code.
- Returns per-topic results and a study recommendation for weak topics — not the correct
  answers to the questions asked.

Edge function 4: resume_exam(attempt_id)
- Returns the attempt at the same question, with remaining time computed from
  server_deadline_at, honouring the policy's timer_behaviour_on_disconnect
  (continue = deadline unchanged; pause = deadline extended by the recorded outage,
  and the outage must be logged in exam_event_logs).
- Must be safe to call repeatedly; never creates a second active session.

Calculation exam specifics (type = calculation):
- Answer is a number plus a separately selected unit.
- Grading uses the question's unit and tolerance. A wrong unit is a wrong answer, not partial
  credit. Do not auto-round the learner's answer.
- The learner may record intermediate steps in a text field; store them with the answer.

UI:
- Pre-exam page listing: time limit, attempt number, allowed aids from the policy, pass mark,
  what happens on disconnect, identification requirement.
- One question at a time, remaining time from the server, flag-for-later.
- On connection loss: a clear message that the answers are saved, then resume at the same point.
- Post-exam: per-topic results, targeted study suggestion, next retry time, and a link to file
  an appeal (exam_appeals).

Write integration tests for: no practice question appears in an exam, two attempts differ,
answers after the deadline are rejected, the pass mark comes from the policy row, and resume
never creates a parallel session.
```

### P4 — Ohjattu harjoittelu ja arvioijan näyttölomake

```text
Build two things.

A) Supervised practice logging (trainer or assessor, mobile):
Select learner, competency, skill, date, feedback, confirm. Shows progress x of y required
entries. The required count comes from the competency_version, not from code.

B) Practical assessment form (assessor, mobile, must work offline):
- Renders form_criteria of the current practical_form version in order, marking critical
  criteria visibly.
- Each criterion: met / partially met / not met. An observation is mandatory for anything
  other than "met".
- Decision: approved / rejected, with a mandatory rationale.
- If any critical criterion is "not met", "approved" must be impossible — disabled in the UI
  AND rejected by the database trigger. Test the API path too, not just the UI.
- Blocks locking the form if the assessor has no valid assessor_qualification covering this
  competency_version at the time of assessment; explain the reason to the user and notify the
  supervisor.
- Records assessor id, qualification id, timestamp and location.
- Offline: the form is fillable without network, stored locally, and synced when back online.
  Show sync state clearly. A locked form is immutable after sync; corrections create a
  practical_corrections row that stays visible.
- A rejected assessment creates a remediation period and a re-assessment item on the learner's
  path. If this is the learner's second rejection for this competency, flag that a different
  assessor is recommended.
```

### P5 — Hyväksyntä, sertifikaatti ja julkinen varmennus

```text
Build the award and certificate flow.

Edge function: evaluate_award(user_id, competency_version_id)
- Checks every mandatory requirement: lessons completed, practice threshold, theory exam
  passed, calculation exam passed (if defined), supervised practice count met, practical
  assessment approved (if requires_practical), and approval by an authorised user.
- Returns a per-requirement list: met / missing / in progress, naming each missing item.
- Only when all are met may it create a competency_award with status valid, valid_to computed
  from the applicable assessment_policies row.
- There must be NO code path — UI, API, or admin role — that creates a valid award or a
  certificate while any mandatory requirement is unmet. Completing a digital course must never
  satisfy a practical assessment requirement.

Certificate generation:
- Three distinct types: attendance, completion, verified_competence. Never conflate them.
- A certificate contains: learner name, training and verified competence name, assessment
  parts completed, issuer and approver, issue date, expiry date, unique id, QR code /
  verification link, content and policy version, scope and limitations.
- Limitations text, always present: "Verified training competence. Not a licence to practise.
  Does not replace an employer's task-specific medication authorisation."
- Certificates can expire, be renewed, corrected and revoked. A revoked certificate keeps its
  record.

Public verification page (separate route, no app authentication):
- Opened from the QR code using public_token.
- Shows ONLY: certificate name, verified competence, issuer, issue date, validity, unique id,
  content and policy version, status (valid / expired / revoked), scope and limitations.
- Must NOT show date of birth, employer, exam results, or the assessor's name.
- A revoked certificate shows clearly as revoked without disclosing the reason.
- Every view is logged in access_logs.
- The token must not be guessable and the page must not allow enumeration.

Also build the learner's competence passport page: valid, expiring and expired competences,
with a share link the learner controls.
```

### P6 — Organisaation näkymä ja muistutukset

```text
Build the supervisor and org_admin views.

Competence matrix:
- Rows = employees in scope, columns = competency_requirements of a selected job_role.
- Cell = one of six states: not started / in progress / awaiting assessment / valid /
  expiring soon / expired. "Expiring soon" is computed from valid_to (within 90 days), never
  stored.
- Filters: site, team, job role, state, expiry window (30/60/90 days), locale.
- Header metrics: requirement coverage %, awaiting assessment, expiring, overdue.
- Row expansion: what is missing, what the next step is, actions "send reminder" and
  "export report".
- IMPORTANT: the view must never label a person as "fit to work" or "competent" overall. It
  shows per-requirement state and coverage against the selected requirement list only.
- Supervisors must not see individual exam answers — only state and result.

Audit export (PDF and CSV): includes the content version and policy version behind each award,
plus the export timestamp and who exported it.

Reminders:
- When a competency_award's valid_to is 90, 60 or 30 days away, notify the learner and their
  supervisor; set a derived "expiring soon" presentation and open a renewal path on request.
- When valid_to passes, the award no longer satisfies any requirement.
- Supervisor digest: one summary notification rather than one per employee.
```

---

## 5. Tarkistuslista ennen pilottia

Nämä vastaavat tuotesuunnitelman hyväksymiskriteerejä. Lovable ei tarkista näitä puolestasi;
aja ne testeinä tai käsin.

| # | Tarkistus | Kriteeri |
| --- | --- | --- |
| 1 | RLS päällä kaikilla tauluilla, organisaatio A ei näe B:n rivejä rajapinnasta | HK-13 |
| 2 | Harjoituskysymys ei voi päätyä kokeeseen (testi, ei silmämääräinen) | HK-4 |
| 3 | Koeaika ei pidenny selaimesta; deadline palvelimella | HK-5 |
| 4 | Hyväksymisrajaa ei löydy koodista eikä defaulteista (grep + SQL-kysely §4) | HK-6 |
| 5 | Kriittinen puute estää hyväksymisen myös suoralla API-kutsulla | HK-7 |
| 6 | Arvioijan pätevyys tarkistetaan lukitessa | HK-8 |
| 7 | Sertifikaattia ei synny puutteellisilla vaatimuksilla admin-oikeuksin | HK-9 |
| 8 | Julkinen varmennussivu ei paljasta henkilötietoja eikä ole enumeroitavissa | HK-10 |
| 9 | Matriisi ei näytä kokonaisarviota "työkelpoinen" | HK-11 |
| 10 | Lukittua arviointia ei voi muuttaa; korjaus jää näkyviin | HK-15 |
| 11 | 360 px leveys ilman vaakavieritystä, näppäimistökäyttö, tekstitykset | HK-16 |

Tee lisäksi `grep -riE "pass_mark|passMark|0\.8|80\b"` generoidun koodin yli ja varmista, ettei
hyväksymisrajaa ole kovakoodattu mihinkään.

---

## 6. Mitä Lovablen jälkeen jää tehtäväksi

| Asia | Miksi ei Lovablella |
| --- | --- |
| Sertifikaatin PDF-generointi ja QR | Vaatii deterministisen ulkoasun, fontit ja allekirjoituksen; tee edge functionissa tai erillisellä palvelulla |
| Offline-arviointilomakkeen synkronointi | Konfliktinratkaisu ja allekirjoitettu puskuri ovat omaa logiikkaa |
| Valvottu koe (proctoring) | V2, erillinen päätös ja mahdollinen kolmannen osapuolen palvelu |
| Hoiwa/AerWork-integraatio ja webhookit | Liite A; tehdään vasta kun rajapinta on sovittu |
| Käännökset | Lovable voi tuottaa i18n-rakenteen, mutta kliinisesti kriittiset käännökset tarkastaa ihminen |
| Tietosuojaratkaisut (säilytysajat, poisto, datan sijainti) | §11 M1 on selvitettävä juristin kanssa ennen tuotantoa |

---

## 7. Avoin päätös ennen aloitusta

Yksi asia pitää päättää ennen vaihetta 1, koska se lukittuu: **Supabase-projektin alue.**
Se riippuu tuotesuunnitelman §11 kohdasta M1 (Malesian ja Indonesian henkilötietosääntely,
datan sijaintivaatimus). Jos selvitys ei ole valmis, aloita dev-projektilla ja luo tuotantoprojekti
vasta päätöksen jälkeen — dev-datassa ei saa tällöin olla oikeita henkilötietoja.

---

## Lähteet (Lovablen integraatiot, luettu 2026-10-09)

- [Lovable Docs — GitHub-integraatio](https://docs.lovable.dev/integrations/github)
- [Lovable Docs — Git sync overview](https://docs.lovable.dev/integrations/git-sync-overview)
- [Lovable Docs — Supabase-integraatio](https://docs.lovable.dev/integrations/supabase)
- [Lovable Docs — Cloud](https://docs.lovable.dev/integrations/cloud)
- [Lovable FAQ — GitHub](https://lovable.dev/faq/github) · [olemassa olevan repon tuonti](https://lovable.dev/faq/github/import-github-repo)
- [Lovable — Supabase-integraatiosivu](https://lovable.dev/integrations/supabase)

Huom: valikkopolut ja Cloudin oletusasetukset ovat muuttuneet aiemmin, ja olemassa olevan repon
liittämisestä docs ja FAQ ovat ristiriidassa. Tarkista elävä käyttöliittymä, jos vaihe ei täsmää.
