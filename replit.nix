{ pkgs }: {
  deps = [
    pkgs.nodejs-18_x
    pkgs.nodePackages.typescript-language-server
    pkgs.yarn
    pkgs.replitPackages.jest
    pkgs.python311
    pkgs.python311Packages.pip
    pkgs.python311Packages.virtualenv
  ];
  env = {
    PYTHONUNBUFFERED = "1";
    PYTHONPATH = "/home/runner/${REPL_SLUG}/core:/home/runner/${REPL_SLUG}";
  };
}
