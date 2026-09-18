# Contributing to MDQ

Thanks for helping improve MDQ. Bug reports, documentation fixes, design
feedback, and code contributions are welcome.

## Contribution licence and authority

MDQ is distributed under the [MIT License](LICENSE). By submitting a pull
request or other contribution, you agree that your contribution is provided
under the same MIT License. You retain copyright in work you create; MDQ does
not require copyright assignment or a separate contributor licence agreement.

The MIT License permits anyone to use, modify, distribute, sublicense, and sell
the software. This includes use in commercial products and services by the MDQ
maintainers, contributors, or unrelated third parties. Please contribute only
if you are comfortable granting those rights.

By contributing, you represent that:

- you created the contribution or otherwise have permission to submit it under
  the MIT License;
- the contribution does not contain confidential information, private class or
  participant data, or material that you are not authorised to disclose; and
- where the work may be owned or controlled by an employer, institution,
  client, funder, or another project, you have obtained any permission required
  before submitting it.

Do not submit work produced as part of assigned employment, institutional or
grant-funded duties unless the relevant rights holder has authorised its
release under the MIT License. If such authorisation is relevant to a material
contribution, note it in the pull request so maintainers can record the
provenance.

Submitting or accepting a contribution does not create employment, payment,
institutional affiliation, endorsement, or a right to participate in any
commercial product or service built with MDQ.

## Development workflow

1. Open an issue before beginning a substantial feature or behavioural change.
2. Create a focused branch and keep the change scoped to one concern.
3. Add or update tests and public documentation where applicable.
4. Run the relevant verification commands. For most changes, start with:

   ```bash
   npm run verify:quick
   ```

5. Open a pull request describing the change, how it was tested, and any
   third-party code, assets, or institutional provenance that reviewers should
   know about.

## Public and private data

MDQ is a public repository. Never commit real quiz data, student or participant
information, session exports, submissions, access logs, credentials, or private
teaching materials. Only intentional public samples and minimal test fixtures
belong in the repository.

