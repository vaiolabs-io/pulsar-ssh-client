#!/usr/bin/env bash
#===============================================================================
# Script:       test-host.sh
# Purpose:      Start, stop and describe a throwaway sshd container so the
#               package can be tested against a real SSH server instead of an
#               in-memory double.
# Developer:    Alex Chapelle <alex@vaiolabs.com>
# Version:      0.0.1
# Last edit:    2026-09-07
#===============================================================================

set -o errexit
set -o pipefail
set -o errtrace

#-------------------------------------------------------------------------------
# Global variables
#-------------------------------------------------------------------------------
NULL="/dev/null"
CUR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
SCRIPT_BASE="${SCRIPT_NAME%.sh}"
SCRIPT_PATH="${CUR_DIR}/${SCRIPT_NAME}"
LOG_DIR="/var/log/${SCRIPT_BASE}"
LOG="${LOG_DIR}/${SCRIPT_BASE}-$(date +%Y_%m_%d-%H_%M).log"
DEPS_DIR="/var/cache/${SCRIPT_BASE}"
DEPS_MARKER="${DEPS_DIR}/.deps"
REQUIRED_CMDS=( date mkdir tee docker ssh-keygen )

IMAGE_NAME="pulsar-ssh-testhost"
CONTAINER_NAME="pulsar-ssh-testhost"
TEST_USER="tester"
BUILD_DIR="${CUR_DIR}/testhost"
KEY_PATH="${BUILD_DIR}/testkey"

# Parsed options - defaulted here so the script is valid with no arguments.
OPT_HELP=0
OPT_VERBOSE=0
OPT_PORT="2222"
OPT_ERROR=""
ARG_OPERANDS=()

#-------------------------------------------------------------------------------
# main - entry point; the only function that reports to the user and exits
#-------------------------------------------------------------------------------
function main() {
    exit_code=0
    action="${ARG_OPERANDS[0]-start}"

    log "info" "started ${SCRIPT_NAME} from ${CUR_DIR}."
    log "info" "options: verbose=${OPT_VERBOSE} port=${OPT_PORT} action=${action}"

    if ! check_dependencies; then
        log "error" "required commands are missing: ${REQUIRED_CMDS[*]}"
        exec 1>&3 3>&-
        exit 1
    fi

    case "${action}" in
        start)
            if ! start_host; then
                log "error" "could not start the test host."
                exit_code=1
            else
                log "info" "test host is up on port ${OPT_PORT}."
                print_env
            fi
            ;;
        stop)
            if ! stop_host; then
                log "error" "could not stop the test host."
                exit_code=1
            else
                log "info" "test host stopped."
            fi
            ;;
        env)
            if ! print_env; then
                log "error" "the test host is not running; start it first."
                exit_code=1
            fi
            ;;
        *)
            log "error" "unknown action '${action}'; expected start, stop or env."
            exit_code=2
            ;;
    esac

    exec 1>&3 3>&-
    exit "${exit_code}"
}

#-------------------------------------------------------------------------------
# parse_args - fill the OPT_* and ARG_* globals; 0 on success, 1 on a bad
#              command line, with the reason left in OPT_ERROR for main to print
#-------------------------------------------------------------------------------
function parse_args() {
    OPTIND=1
    OPT_ERROR=""
    ARG_OPERANDS=()

    while getopts ":hvp:-:" parsed_flag; do
        parsed_value=""
        parsed_wants_value=0

        if [[ "${parsed_flag}" == "-" ]]; then
            parsed_name="${OPTARG%%=*}"
            if [[ "${parsed_name}" == "${OPTARG}" ]]; then
                parsed_wants_value=1
            else
                parsed_value="${OPTARG#*=}"
            fi
        else
            parsed_value="${OPTARG}"
            case "${parsed_flag}" in
                h) parsed_name="help"    ;;
                v) parsed_name="verbose" ;;
                p) parsed_name="port"    ;;
                *) parsed_name="${parsed_flag}" ;;
            esac
        fi

        if [[ "${parsed_flag}" == "-" ]] && (( parsed_wants_value == 0 )); then
            case "${parsed_name}" in
                help | verbose)
                    OPT_ERROR="option --${parsed_name} takes no value."
                    return 1
                    ;;
            esac
        fi

        case "${parsed_name}" in
            help)
                OPT_HELP=1
                ;;
            verbose)
                OPT_VERBOSE=1
                ;;
            port)
                if (( parsed_wants_value )); then
                    if (( OPTIND > $# )); then
                        OPT_ERROR="option --port needs a value."
                        return 1
                    fi
                    parsed_value="${!OPTIND}"
                    OPTIND=$(( OPTIND + 1 ))
                fi
                OPT_PORT="${parsed_value}"
                ;;
            :)
                OPT_ERROR="option -${OPTARG} needs a value."
                return 1
                ;;
            '?')
                OPT_ERROR="unknown option -${OPTARG}."
                return 1
                ;;
            *)
                OPT_ERROR="unknown option --${parsed_name}."
                return 1
                ;;
        esac
    done

    ARG_OPERANDS=( "${@:OPTIND}" )
    return 0
}

#-------------------------------------------------------------------------------
# get_header_field - print one field from this script's own header block
#-------------------------------------------------------------------------------
function get_header_field() {
    if ! sed -n "/^# ${1}:/{s/^# ${1}:[[:space:]]*//;p;q;}" "${SCRIPT_PATH}"; then
        return 1
    fi
    return 0
}

#-------------------------------------------------------------------------------
# usage - return the help text; never prints, never exits
#-------------------------------------------------------------------------------
function usage() {
    printf '%s\n' "NAME"
    printf '%s\n' "    ${SCRIPT_NAME} - $(get_header_field 'Purpose')"
    printf '%s\n' ""
    printf '%s\n' "SYNOPSIS"
    printf '%s\n' "    ${SCRIPT_NAME} [-h|--help] [-v|--verbose] [-p|--port PORT] [--] [start|stop|env]"
    printf '%s\n' ""
    printf '%s\n' "DESCRIPTION"
    printf '%s\n' "    Builds and runs a Debian container running sshd, with a throwaway"
    printf '%s\n' "    key pair generated on first use. The container sets"
    printf '%s\n' "    'AllowTcpForwarding no' on purpose: this package must work without"
    printf '%s\n' "    it, unlike the VS Code extension it reimplements."
    printf '%s\n' ""
    printf '%s\n' "    The 'env' action prints the environment the integration specs read."
    printf '%s\n' ""
    printf '%s\n' "OPTIONS"
    printf '%s\n' "    -h, --help"
    printf '%s\n' "        Print this help and exit."
    printf '%s\n' ""
    printf '%s\n' "    -v, --verbose"
    printf '%s\n' "        Log more detail about each step."
    printf '%s\n' ""
    printf '%s\n' "    -p PORT, --port PORT, --port=PORT"
    printf '%s\n' "        Host port to publish sshd on. Default 2222."
    printf '%s\n' ""
    printf '%s\n' "EXIT STATUS"
    printf '%s\n' "    0    The action succeeded."
    printf '%s\n' "    1    The action failed."
    printf '%s\n' "    2    The command line was wrong."
    printf '%s\n' ""
    printf '%s\n' "EXAMPLES"
    printf '%s\n' "    ${SCRIPT_NAME}"
    printf '%s\n' "        Build if needed and start the test host on port 2222."
    printf '%s\n' ""
    printf '%s\n' "    ${SCRIPT_NAME} --port 2299 start"
    printf '%s\n' "        Start it on a different port."
    printf '%s\n' ""
    printf '%s\n' "    eval \"\$(${SCRIPT_NAME} -- env)\" && pulsar --test spec"
    printf '%s\n' "        Export the test environment, then run the suite against it."
    printf '%s\n' ""
    printf '%s\n' "AUTHOR"
    printf '%s\n' "    $(get_header_field 'Developer')"
    printf '%s\n' ""
    printf '%s\n' "VERSION"
    printf '%s\n' "    $(get_header_field 'Version') ($(get_header_field 'Last edit'))"
    return 0
}

#-------------------------------------------------------------------------------
# check_root - 0 when running as root, 1 otherwise
#-------------------------------------------------------------------------------
function check_root() {
    if [[ "${EUID}" -ne 0 ]]; then
        return 1
    fi
    return 0
}

#-------------------------------------------------------------------------------
# init_log - create the log folder and tee all output into it
#-------------------------------------------------------------------------------
function init_log() {
    if ! mkdir -p "${LOG_DIR}" 1>"${NULL}" 2>&1; then
        return 1
    fi

    exec 3>&1
    exec 1> >(tee -a "${LOG}" >&3) 2>&1

    return 0
}

#-------------------------------------------------------------------------------
# log - the single printer; level is info, warn, error or debug
#-------------------------------------------------------------------------------
function log() {
    level="${1}"
    message="${2}"
    case "${level}" in
        info)  level="INFO"  ;;
        warn)  level="WARN"  ;;
        error) level="ERROR" ;;
        debug) level="DEBUG" ;;
    esac
    printf '[%s] [%-5s] %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "${level}" "${message}"
    return 0
}

#-------------------------------------------------------------------------------
# check_dependencies - verify the external commands exist, cached in /var/cache
#-------------------------------------------------------------------------------
function check_dependencies() {
    deps_cached=""

    if [[ "${DEPS_MARKER}" -nt "${SCRIPT_PATH}" ]] \
        && read -r deps_cached < "${DEPS_MARKER}" \
        && [[ "${deps_cached}" == "${REQUIRED_CMDS[*]}" ]]; then
        return 0
    fi

    for deps_cmd in "${REQUIRED_CMDS[@]}"; do
        if ! command -v "${deps_cmd}" 1>"${NULL}" 2>&1; then
            return 1
        fi
    done

    if mkdir -p "${DEPS_DIR}" 1>"${NULL}" 2>&1; then
        if ! printf '%s\n' "${REQUIRED_CMDS[*]}" 1>"${DEPS_MARKER}" 2>"${NULL}"; then
            return 0
        fi
    fi

    return 0
}

#-------------------------------------------------------------------------------
# make_key - generate the throwaway key pair if it is not already there
#-------------------------------------------------------------------------------
function make_key() {
    if [[ -f "${KEY_PATH}" ]]; then
        return 0
    fi

    if ! mkdir -p "${BUILD_DIR}" 1>"${NULL}" 2>&1; then
        return 1
    fi

    if ! ssh-keygen -t ed25519 -N '' -f "${KEY_PATH}" -C 'pulsar-ssh-client-test' -q; then
        return 1
    fi

    return 0
}

#-------------------------------------------------------------------------------
# write_dockerfile - lay down the build context for the test image
#-------------------------------------------------------------------------------
function write_dockerfile() {
    if ! mkdir -p "${BUILD_DIR}" 1>"${NULL}" 2>&1; then
        return 1
    fi

    # An unquoted heredoc, so ${TEST_USER} is substituted. That also expands
    # every other $ and runs every backtick, so the content below deliberately
    # contains neither. Keep it that way when editing.
    cat 1>"${BUILD_DIR}/Dockerfile" 2>"${NULL}" <<EOF
FROM debian:13-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/sshd \
    && useradd -m -s /bin/bash ${TEST_USER}
COPY testkey.pub /home/${TEST_USER}/.ssh/authorized_keys
RUN chown -R ${TEST_USER}:${TEST_USER} /home/${TEST_USER}/.ssh \
    && chmod 700 /home/${TEST_USER}/.ssh \
    && chmod 600 /home/${TEST_USER}/.ssh/authorized_keys
# Deliberately off: this package must not need port forwarding, unlike the
# VS Code extension it reimplements.
RUN printf 'AllowTcpForwarding no\n' >> /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd","-D","-e"]
EOF

    return 0
}

#-------------------------------------------------------------------------------
# build_image - build the test image if it is not already present
#-------------------------------------------------------------------------------
function build_image() {
    if docker image inspect "${IMAGE_NAME}" 1>"${NULL}" 2>&1; then
        return 0
    fi

    if ! docker build -t "${IMAGE_NAME}" "${BUILD_DIR}"; then
        return 1
    fi

    return 0
}

#-------------------------------------------------------------------------------
# stop_host - remove the container if it exists; absent is success
#-------------------------------------------------------------------------------
function stop_host() {
    if ! docker container inspect "${CONTAINER_NAME}" 1>"${NULL}" 2>&1; then
        return 0
    fi

    if ! docker rm -f "${CONTAINER_NAME}" 1>"${NULL}" 2>&1; then
        return 1
    fi

    return 0
}

#-------------------------------------------------------------------------------
# start_host - make the key, build the image, run the container, wait for sshd
#-------------------------------------------------------------------------------
function start_host() {
    if ! make_key; then
        return 1
    fi

    if ! cp "${KEY_PATH}.pub" "${BUILD_DIR}/testkey.pub"; then
        return 1
    fi

    if ! write_dockerfile; then
        return 1
    fi

    if ! build_image; then
        return 1
    fi

    if ! stop_host; then
        return 1
    fi

    if ! docker run -d --name "${CONTAINER_NAME}" -p "${OPT_PORT}:22" "${IMAGE_NAME}" 1>"${NULL}" 2>&1; then
        return 1
    fi

    if ! wait_for_sshd; then
        return 1
    fi

    return 0
}

#-------------------------------------------------------------------------------
# wait_for_sshd - poll until the server answers, up to 30 tries
#-------------------------------------------------------------------------------
function wait_for_sshd() {
    wait_try=0

    while (( wait_try < 30 )); do
        if ssh -o BatchMode=yes \
               -o StrictHostKeyChecking=no \
               -o UserKnownHostsFile="${NULL}" \
               -o ConnectTimeout=2 \
               -i "${KEY_PATH}" \
               -p "${OPT_PORT}" \
               "${TEST_USER}@127.0.0.1" true 1>"${NULL}" 2>&1; then
            return 0
        fi

        wait_try=$(( wait_try + 1 ))
        sleep 1
    done

    return 1
}

#-------------------------------------------------------------------------------
# print_env - print the environment the integration specs read
#-------------------------------------------------------------------------------
function print_env() {
    if ! docker container inspect "${CONTAINER_NAME}" 1>"${NULL}" 2>&1; then
        return 1
    fi

    printf '%s\n' "export PULSAR_SSH_TEST_HOST=127.0.0.1"
    printf '%s\n' "export PULSAR_SSH_TEST_PORT=${OPT_PORT}"
    printf '%s\n' "export PULSAR_SSH_TEST_USER=${TEST_USER}"
    printf '%s\n' "export PULSAR_SSH_TEST_KEY=${KEY_PATH}"

    return 0
}

#-------------------------------------------------------------------------------
# Setup preamble - the only work at file scope
#-------------------------------------------------------------------------------
if ! parse_args "$@"; then
    printf '%s: %s\n' "${SCRIPT_NAME}" "${OPT_ERROR}" >&2
    printf '%s\n' "$(usage)" >&2
    exit 2
fi

if (( OPT_HELP )); then
    printf '%s\n' "$(usage)"
    exit 0
fi

if ! check_root; then
    printf '%s: run this script as root or with sudo.\n' "${SCRIPT_NAME}" >&2
    exit 1
fi

if ! init_log; then
    printf '%s: cannot create log file in %s.\n' "${SCRIPT_NAME}" "${LOG_DIR}" >&2
    exit 1
fi

main "$@"
