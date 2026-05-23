# AWS EC2 Provider

The `aws-ec2` provider runs rootcell's agent and firewall VMs as EC2
instances. Rootcell creates a dedicated VPC per rootcell instance and manages
AWS infrastructure with a generated Terraform-compatible module. It runs
OpenTofu's `tofu` command by default; set
`ROOTCELL_TERRAFORM=/path/to/terraform` to use a Terraform binary you installed
yourself.

## Required Instance Environment

Initialize the instance `.env` before first use:

```sh
./rootcell -i aws-dev --init-env aws-ec2
./rootcell -i aws-dev edit env
```

The command writes these provider settings:

```sh
ROOTCELL_VM_PROVIDER=aws-ec2
ROOTCELL_AWS_PROFILE=your-profile
ROOTCELL_AWS_REGION=us-east-1
ROOTCELL_AWS_CONTROL_CIDR=auto
```

`ROOTCELL_AWS_PROFILE` and `ROOTCELL_AWS_REGION` are required. Rootcell does
not fall back to `AWS_PROFILE` or `AWS_REGION` for provider selection.

`ROOTCELL_AWS_CONTROL_CIDR=auto` resolves your current public IPv4 address to a
single `/32` when OpenTofu is applied. If that address changes, normal
`rootcell` entry fails with instructions to run `rootcell provision` so the
firewall SSH ingress rule is updated intentionally.

## OpenTofu / Terraform Layout

Rootcell writes one Terraform-compatible module per instance:

```text
<instance-dir>/v/aws-ec2/
  metadata.json
  terraform/
    main.tf
    variables.tf
    outputs.tf
    terraform.tfvars.json
    terraform.tfstate
    .terraform.lock.hcl
```

Terraform state is the ownership record for AWS resources. Normal VM entry does
not run `tofu init` or `tofu apply`; it reads cached infrastructure outputs,
checks EC2 status, syncs allowlists, injects explicitly configured
session secrets, and opens SSH through the firewall.

OpenTofu runs for first create, explicit `rootcell provision`,
state-backed start/stop transitions, and `rootcell remove`.

Default EC2 sizing is:

| VM | Instance type | Root volume |
| --- | --- | --- |
| agent | `t4g.2xlarge` | 60 GiB |
| firewall | `t4g.small` | 64 GiB |

Override root volume sizes only before creating or reprovisioning an instance:

```sh
ROOTCELL_AWS_AGENT_ROOT_VOLUME_GIB=60
ROOTCELL_AWS_FIREWALL_ROOT_VOLUME_GIB=64
```

## Upstream NixOS AMI

AWS EC2 instances boot from the official upstream NixOS ARM64 AMI. Rootcell
does not use rootcell-owned release image manifests, VM Import/Export, imported
snapshots, generated AMIs, or S3 image staging.

OpenTofu resolves the AMI at apply time:

```hcl
data "aws_ami" "nixos_arm64" {
  owners      = [var.nixos_ami_owner_id]
  most_recent = true

  filter {
    name   = "name"
    values = [var.nixos_ami_name_pattern]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }
}
```

The default owner is the official NixOS AMI publisher account
`427812963091`, and the default name pattern is `nixos/25.11*`. Override them
only when intentionally testing a different upstream image stream:

```sh
ROOTCELL_AWS_NIXOS_AMI_OWNER_ID=427812963091
ROOTCELL_AWS_NIXOS_AMI_NAME_PATTERN='nixos/25.11*'
```

Official NixOS AMIs initially accept SSH as `root`. Rootcell supplies a
non-secret EC2 user-data script containing only the generated SSH public key to
create the normal `luser` account before rootcell connects. No credentials or
secrets are placed in user data.

## Ownership Tags

Every AWS resource rootcell creates must have these tags where the AWS API
supports tagging:

```text
RootcellManaged=true
RootcellInstanceName=<instance-name>
```

This includes VPC resources, security groups, key pairs, ENIs, EIPs, EC2
instances, and root EBS volumes. The upstream NixOS AMI is not created by
rootcell and is not tagged or removed by rootcell. `rootcell remove` refuses to
delete recorded AWS resources that do not have both tags with the expected
values.

## IAM And Credential Isolation

Rootcell does not attach an IAM instance profile to the agent or firewall. The
generated Terraform-compatible module must not create IAM roles, IAM instance
profiles, or instance-profile associations for those instances.

Rootcell never copies host `~/.aws` files into either VM and never injects AWS
credentials unless the user explicitly maps them in `secrets.env`.

IMDS remains enabled for diagnostics such as instance ID, AZ, and network
metadata, but it is hardened:

```hcl
metadata_options {
  http_endpoint               = "enabled"
  http_tokens                 = "required"
  http_put_response_hop_limit = 1
  instance_metadata_tags      = "disabled"
}
```

Do not put secrets in user data. Allowlisting AWS SDK endpoints grants network
reachability only; without explicitly injected credentials, the agent should not
be able to call same-account AWS APIs. Integration tests verify that
`aws sts get-caller-identity` fails inside the agent unless credentials were
explicitly injected.
